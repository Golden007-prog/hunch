/** Finished tasks as graph memory: `.hunch/tasks/htask_*.json`.
 *
 * The observation ledger (`.hunch-cache/served.db`) is machine-local and expires;
 * the graph is what Hunch knows. When a task finishes with at least one
 * observation, a bounded summary of it is written through the SAME capture path
 * as decisions and findings (`HunchStore.putCapture`), so public/private homing,
 * the one-home-per-record rule, auto-commit and team routing apply unchanged.
 *
 * Empty tasks (nothing delivered, saved, checked, claimed or denied) stay
 * ledger-only: a record per bare prompt would be commit noise, not memory.
 * The record carries titles and record references only — never prompt text,
 * transcript, private context payloads or denial reasons. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushCapture } from "../integrations/sync.js";
import type { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "./paths.js";
import { isEmptyTaskReport, readTaskReport, reportHash, type TaskReport, type TaskSummary } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { ENTITY_KINDS, TaskRecordSchema, type EntityKind, type TaskRecord } from "./types.js";
import { refreshRankEval } from "./taskRankingMode.js";

export type TaskRecordHome = "public" | "private";

function localConfig(root: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

/** `taskRecords: false` in `.hunch/local.json` keeps tasks ledger-only. */
export function taskRecordsEnabled(root: string): boolean {
  return localConfig(root).taskRecords !== false;
}

/** `taskRecordsFlush: "batch"` writes the record but leaves the commit to the
 * next capture flush (decision, finding, correction), so a busy repository
 * gets one memory commit per real capture instead of one per prompt. Default
 * "each": every finished task commits like any other capture. */
export function taskRecordFlushMode(root: string): "each" | "batch" {
  return localConfig(root).taskRecordsFlush === "batch" ? "batch" : "each";
}

/** A delivery target that names code (a path or dotted symbol), not a task
 * phrase like "fix the login redirect". Phrases never become file anchors. */
export function targetLooksLikePath(target: string): boolean {
  const t = target.trim();
  if (!t || t.length > 512 || /\s/.test(t)) return false;
  if (!/^[A-Za-z0-9_@$./\\:-]+$/.test(t)) return false;
  return /[./\\]/.test(t) && !/^\.+$/.test(t);
}

/** The durable summary of a finished report, or null when there is nothing to keep. */
export function taskRecordFromReport(report: TaskReport): TaskRecord | null {
  const { task } = report;
  if (task.state === "open" || !task.finished_at) return null;
  if (isEmptyTaskReport(report)) return null;
  const lessons = new Map<string, TaskRecord["lessons"][number]>();
  for (const delivery of report.deliveries) {
    for (const r of delivery.records) {
      lessons.set(`${r.kind}:${r.record_id}:${r.content_hash}`, { kind: r.kind, record_id: r.record_id, content_hash: r.content_hash, title: r.title.slice(0, 200) });
    }
  }
  const files = new Set<string>();
  for (const d of report.deliveries) if (d.target && targetLooksLikePath(d.target)) files.add(d.target.trim().replace(/\\/g, "/"));
  for (const c of report.conformance) for (const f of c.files) files.add(f);
  for (const r of report.refusals) files.add(r.target);
  const latestRule = new Map<string, TaskRecord["conformance"][number]>();
  for (const c of report.conformance) {
    latestRule.set(`${c.kind}:${c.record_id}:${c.content_hash}`, { kind: c.kind, record_id: c.record_id, content_hash: c.content_hash, outcome: c.outcome });
  }
  const lastCheck = report.checks.at(-1);
  return TaskRecordSchema.parse({
    id: task.task_id,
    title: task.title,
    state: task.state,
    started_at: task.started_at,
    finished_at: task.finished_at,
    coverage: report.coverage,
    lessons: [...lessons.values()],
    applied: report.claims.map((c) => ({ record_id: c.record_id, content_hash: c.content_hash, action: c.action.slice(0, 300), supported_by: c.supported_by })),
    saved: report.saves.map((s) => ({ kind: s.record.kind, record_id: s.record.record_id, content_hash: s.record.content_hash, home: s.home, operation: s.operation, durability: s.durability })),
    checks: report.checks.map((c) => ({ label: c.label, state: c.cancelled ? "cancelled" : c.timed_out ? "timed out" : c.exit_code === 0 ? "passed" : "failed", exit_code: c.exit_code })),
    conformance: [...latestRule.values()],
    refusals: report.refusals.length,
    files: [...files].sort().slice(0, 64),
    source_snapshot: lastCheck?.after_snapshot ?? null,
    report_hash: report.content_hash,
    provenance: { source: "task_report", confidence: 1, evidence: [`hunch report ${task.task_id}`], last_verified: task.finished_at },
  });
}

/** Where the record belongs. Anything that touched the private overlay — a
 * private save, or a delivered lesson that lives only there — must not be named
 * in a public record; the store's own routing (unified/shared mode) wins first. */
export function taskRecordHome(store: HunchStore, record: TaskRecord): TaskRecordHome {
  if (store.captureHome(false) === "private") return "private";
  if (!store.hasPrivate) return "public";
  if (record.saved.some((s) => s.home === "private")) return "private";
  for (const lesson of record.lessons) {
    if (!(ENTITY_KINDS as readonly string[]).includes(lesson.kind)) continue;
    const kind = lesson.kind as EntityKind;
    if (store.getPrivateRec(kind, lesson.record_id) && !store.json.get(kind, lesson.record_id)) return "private";
  }
  return "public";
}

/** Older records this one verified over: same file, a shared record, and this
 * task's last check passed with no rule violated. Superseded records stay in
 * the graph (append-only) but are never delivered; the newer line carries the
 * verified state. Bounded. */
export function computeSupersedes(record: TaskRecord, others: readonly TaskRecord[], limit = 20): string[] {
  const last = record.checks.at(-1);
  if (!last || last.state !== "passed") return [];
  if (record.conformance.some((c) => c.outcome === "violated")) return [];
  const files = new Set(record.files.map((f) => f.replace(/\\/g, "/")));
  const ids = new Set([...record.lessons.map((l) => l.record_id), ...record.applied.map((a) => a.record_id), ...record.saved.map((s) => s.record_id)]);
  if (!files.size || !ids.size) return [];
  const out: string[] = [];
  for (const o of others) {
    if (o.id === record.id || o.finished_at >= record.finished_at) continue;
    if (!o.files.some((f) => files.has(f.replace(/\\/g, "/")))) continue;
    const oids = [...o.lessons.map((l) => l.record_id), ...o.applied.map((a) => a.record_id), ...o.saved.map((s) => s.record_id)];
    if (!oids.some((id) => ids.has(id))) continue;
    out.push(o.id);
  }
  return out.sort().slice(0, limit);
}

export interface PersistedTaskRecord {
  record: TaskRecord;
  home: TaskRecordHome;
  flushed: "pushed" | "committed" | null;
  /** False when the same report revision was already in the graph. */
  changed: boolean;
}

/** Write (or refresh) the graph record for a finished task. Idempotent on the
 * report hash. A record never changes home once written. Returns null for an
 * open task, an empty report, or when task records are disabled locally. */
export function persistTaskRecord(root: string, store: HunchStore, taskId: string, options: { flush?: boolean } = {}): PersistedTaskRecord | null {
  if (!taskRecordsEnabled(root)) return null;
  const report = readTaskReport(root, taskId, reportSourceSnapshot(root).hash);
  const built = taskRecordFromReport(report);
  if (!built) return null;
  const record: TaskRecord = { ...built, supersedes: computeSupersedes(built, store.recs("tasks")) };
  const inPrivate = store.hasPrivate ? store.getPrivateRec("tasks", record.id) : undefined;
  const inPublic = store.json.get("tasks", record.id);
  const home: TaskRecordHome = inPrivate ? "private" : inPublic ? "public" : taskRecordHome(store, record);
  const existing = home === "private" ? inPrivate : inPublic;
  if (existing && existing.report_hash === record.report_hash) return { record: existing, home, flushed: null, changed: false };
  const stored = store.putCapture("tasks", record, home === "private");
  store.reindex();
  const flushNow = options.flush ?? taskRecordFlushMode(root) === "each";
  const flushed = flushNow ? flushCapture(store, hunchPaths(root).hunch, home === "private", `hunch: task ${record.id}`) : null;
  // The ranking evaluation follows the corpus: recomputed here, read at delivery. Never blocks a finish.
  refreshRankEval(root, store);
  return { record: stored, home, flushed, changed: true };
}

const GRAPH_SCOPE = reportHash("graph-record");

/** A ledger-shaped summary for a task known only from the graph (another
 * machine, a teammate, or a pruned local ledger). */
export function summaryFromTaskRecord(record: TaskRecord, home: TaskRecordHome): TaskSummary {
  const last = record.checks.at(-1);
  return {
    task: { task_id: record.id, scope: GRAPH_SCOPE, title: record.title, started_at: record.started_at, finished_at: record.finished_at, state: record.state },
    deliveries: record.lessons.length ? 1 : 0,
    lessons: new Set(record.lessons.map((l) => `${l.kind}:${l.record_id}`)).size,
    claims: record.applied.length,
    saves: record.saved.length,
    refusals: record.refusals,
    check: last ? { label: last.label, state: last.state, current: false } : null,
    violated: record.conformance.some((c) => c.outcome === "violated"),
    coverage: record.coverage,
    empty: false,
    report_html: null,
    error: null,
    durable: { home },
  };
}

/** Ledger summaries annotated with their graph home, plus graph-only tasks the
 * local ledger never saw. Newest first, bounded. */
export function mergeDurableTaskSummaries(store: HunchStore, summaries: TaskSummary[], limit = 30): TaskSummary[] {
  const homes = new Map<string, TaskRecordHome>();
  const records = new Map<string, TaskRecord>();
  for (const r of store.recsInHome("tasks", "public")) { homes.set(r.id, "public"); records.set(r.id, r); }
  if (store.hasPrivate) for (const r of store.recsInHome("tasks", "private")) { homes.set(r.id, "private"); records.set(r.id, r); }
  const seen = new Set<string>();
  const merged: TaskSummary[] = summaries.map((s) => {
    seen.add(s.task.task_id);
    const home = homes.get(s.task.task_id);
    return { ...s, durable: home ? { home } : null };
  });
  for (const r of records.values()) {
    if (seen.has(r.id)) continue;
    merged.push(summaryFromTaskRecord(r, homes.get(r.id) ?? "public"));
  }
  merged.sort((a, b) => b.task.started_at.localeCompare(a.task.started_at));
  return merged.slice(0, Math.max(1, limit));
}
