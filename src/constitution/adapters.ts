import { basename } from "node:path";
import { shortHash } from "../core/ids.js";
import type { Bug, Constraint } from "../core/types.js";
import { commitMeta } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { durationCutoff } from "./bootstrap.js";
import { canonicalHash } from "./canonical.js";
import type { PolicyRepository } from "./repository.js";
import { EvidenceEventSchema, type EvidenceEvent } from "./schema.js";

export interface LocalEvidenceOptions {
  since?: string;
  maxEvents?: number;
  publicOnly?: boolean;
  privateOnly?: boolean;
  now?: string;
}

export interface LocalEvidenceReport {
  scanned: number;
  eligible: number;
  normalized: number;
  existing: number;
  covered: number;
  uncompilable: number;
  excluded: number;
  events: EvidenceEvent[];
}

interface PendingEvent {
  occurredAt: string;
  event: EvidenceEvent;
  private: boolean;
}

function limit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function exactRecords(store: HunchStore, opts: LocalEvidenceOptions): { constraints: Constraint[]; bugs: Bug[] } {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly) {
    if (!store.hasPrivate) throw new Error("private evidence ingestion needs a configured Hunch private overlay");
    return { constraints: store.recsInHome("constraints", "private"), bugs: store.recsInHome("bugs", "private") };
  }
  if (opts.publicOnly) return { constraints: store.json.loadAll("constraints"), bugs: store.json.loadAll("bugs") };
  return { constraints: store.recs("constraints"), bugs: store.recs("bugs") };
}

function isPrivateRecord(store: HunchStore, kind: "constraints" | "bugs", id: string, opts: LocalEvidenceOptions): boolean {
  if (opts.privateOnly) return true;
  if (opts.publicOnly) return false;
  return !!store.getPrivateRec(kind, id);
}

function correctionEvent(root: string, constraint: Constraint, isPrivate: boolean): PendingEvent | null {
  const occurredAt = constraint.valid_from ?? constraint.provenance.last_verified;
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const contentHash = canonicalHash({
    constraint: constraint.id,
    statement: constraint.statement,
    scope: constraint.scope,
    forbids: constraint.forbids,
    match: constraint.match,
    source_decision: constraint.source_decision,
  });
  const event = EvidenceEventSchema.parse({
    id: `ev_${shortHash(`correction:${contentHash}`)}`,
    kind: "correction",
    occurred_at: occurredAt,
    repository: basename(root),
    files: constraint.scope.filter((scope) => scope !== "**"),
    symbols: constraint.forbids?.symbols ?? [],
    text_ref: constraint.id,
    related_records: [constraint.id, ...(constraint.source_decision ? [constraint.source_decision] : [])],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    compiler: {
      status: "covered",
      policy: null,
      reason: "Active human-confirmed legacy Constraint already delivers deterministic correction enforcement; Policy IR bridge remains explicit follow-on work.",
    },
    provenance: {
      source: "derived",
      confidence: 1,
      evidence: [constraint.id, ...constraint.provenance.evidence],
      last_verified: constraint.provenance.last_verified,
    },
  });
  return { occurredAt, event, private: isPrivate };
}

function bugEvent(
  root: string,
  store: HunchStore,
  repository: PolicyRepository,
  bug: Bug,
  isPrivate: boolean,
  opts: LocalEvidenceOptions,
): PendingEvent | null {
  const commit = bug.lineage.fixed_commit ?? bug.lineage.introduced_commit;
  const meta = commit ? commitMeta(commit, root) : null;
  const occurredAt = meta?.date ?? bug.provenance.last_verified;
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const kind = bug.lineage.detected ? "test_failure" : "incident";
  const related = [
    bug.id,
    bug.lineage.recurrence_of,
    bug.lineage.spawned_decision,
    bug.lineage.spawned_constraint,
  ].filter((value): value is string => !!value);
  const contentHash = canonicalHash({
    bug: bug.id,
    root_cause: bug.root_cause,
    files: bug.affected_files,
    symbols: bug.affected_symbols,
    lineage: bug.lineage,
  });
  const homeView = { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
  const policy = bug.lineage.spawned_decision
    ? repository.listPolicies(homeView).find((candidate) => candidate.legacy_refs.includes(bug.lineage.spawned_decision!))
    : undefined;
  const constraint = bug.lineage.spawned_constraint
    ? opts.publicOnly
      ? store.json.get("constraints", bug.lineage.spawned_constraint)
      : opts.privateOnly
        ? store.getPrivateRec("constraints", bug.lineage.spawned_constraint)
        : store.getRec("constraints", bug.lineage.spawned_constraint)
    : undefined;
  const covered = !!policy || constraint?.status === "active";
  const event = EvidenceEventSchema.parse({
    id: `ev_${shortHash(`${kind}:${contentHash}`)}`,
    kind,
    occurred_at: occurredAt,
    repository: basename(root),
    ...(meta ? { actor: meta.author, commit: meta.sha, diff_ref: `git:${meta.sha}` } : {}),
    files: bug.affected_files,
    symbols: bug.affected_symbols,
    text_ref: bug.id,
    related_records: [...related, ...(policy ? [policy.id] : [])],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    compiler: covered
      ? {
          status: "covered",
          policy: policy?.id ?? null,
          reason: policy
            ? "Spawned decision already has equivalent Policy IR coverage."
            : "Spawned active legacy Constraint already covers this failure; Policy IR bridge remains pending.",
        }
      : {
          status: "uncompilable",
          policy: null,
          reason: "Incident/test evidence normalized, but no attributable supported assertion or existing deterministic guard is linked.",
        },
    provenance: {
      source: "derived",
      confidence: bug.provenance.confidence,
      evidence: [bug.id, ...bug.provenance.evidence],
      last_verified: bug.provenance.last_verified,
    },
  });
  return { occurredAt, event, private: isPrivate };
}

/** Normalize existing local Hunch truth into Constitution EvidenceEvents. This
 * adapter never synthesizes intent and never creates or activates a policy. */
export function ingestLocalEvidence(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  opts: LocalEvidenceOptions = {},
): LocalEvidenceReport {
  const now = opts.now ?? new Date().toISOString();
  const minDate = durationCutoff(opts.since ?? "90d", now);
  const records = exactRecords(store, opts);
  const pending: PendingEvent[] = [];
  let excluded = 0;
  for (const constraint of records.constraints) {
    if (constraint.status !== "active" || !constraint.provenance.source.includes("human_confirmed")) {
      excluded++;
      continue;
    }
    const item = correctionEvent(root, constraint, isPrivateRecord(store, "constraints", constraint.id, opts));
    if (!item || Date.parse(item.occurredAt) < minDate) excluded++;
    else pending.push(item);
  }
  for (const bug of records.bugs) {
    const attributable = !!bug.lineage.detected || (!!bug.root_cause.trim() && bug.provenance.confidence >= 0.7);
    if (!attributable) {
      excluded++;
      continue;
    }
    const item = bugEvent(root, store, repository, bug, isPrivateRecord(store, "bugs", bug.id, opts), opts);
    if (!item || Date.parse(item.occurredAt) < minDate) excluded++;
    else pending.push(item);
  }
  pending.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.event.id.localeCompare(b.event.id));
  const selected = pending.slice(0, limit(opts.maxEvents));
  excluded += Math.max(0, pending.length - selected.length);
  const report: LocalEvidenceReport = {
    scanned: records.constraints.length + records.bugs.length,
    eligible: pending.length,
    normalized: 0,
    existing: 0,
    covered: 0,
    uncompilable: 0,
    excluded,
    events: [],
  };
  const homeView = { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
  for (const item of selected) {
    const existing = repository.getEvidence(item.event.id, homeView);
    const event = existing ?? repository.putEvidence(item.event, { private: item.private });
    if (existing) report.existing++;
    else report.normalized++;
    if (event.compiler?.status === "covered") report.covered++;
    if (event.compiler?.status === "uncompilable") report.uncompilable++;
    report.events.push(event);
  }
  return report;
}
