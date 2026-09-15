/** Recent finished tasks as delivered context.
 *
 * Task records (`.hunch/tasks/`) say what earlier agent work did around a file:
 * which lessons it received, what it applied, saved and checked, and whether a
 * rule was violated. Delivering the newest few next to the invariants lets the
 * next agent build on verified work instead of rediscovering it. Supplements
 * share the brief's budget and are advisory: a task line is history, never a
 * rule, and never an instruction to repeat or skip anything. */
import type { DeliverySupplement } from "./delivery.js";
import type { TaskRecord } from "./types.js";

export const TASK_SUPPLEMENT_LIMIT = 3;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** One bounded line for a task: identity, when, what reached it, what it did. */
export function describeTaskRecord(t: TaskRecord): string {
  const when = t.finished_at.slice(0, 10);
  const lessons = t.lessons.length
    ? `${t.lessons.length} lesson(s): ${t.lessons.slice(0, 3).map((l) => l.record_id).join(", ")}${t.lessons.length > 3 ? "…" : ""}`
    : "no memory delivered";
  const applied = t.applied.length
    ? `applied ${t.applied.length} (${t.applied.some((a) => a.supported_by) ? "rule-supported" : "agent-reported"})`
    : null;
  const saved = t.saved.length ? `saved ${t.saved.slice(0, 3).map((s) => s.record_id).join(", ")}${t.saved.length > 3 ? "…" : ""}` : null;
  const last = t.checks.at(-1);
  const check = last ? `check "${clip(last.label, 40)}" ${last.state}` : "no check recorded";
  const violated = t.conformance.some((c) => c.outcome === "violated") ? "RULE VIOLATED" : null;
  const denied = t.refusals ? `${t.refusals} edit(s) denied` : null;
  const files = t.files.length ? `files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? "…" : ""}` : null;
  return `${t.id} · ${when} · ${t.state} · "${clip(t.title, 80)}" — ${[lessons, applied, saved, check, violated, denied, files].filter(Boolean).join(" · ")}`;
}

/** Newest first, bounded. Empty input yields no supplement at all (no header noise). */
export function taskSupplements(tasks: readonly TaskRecord[], target: string, limit = TASK_SUPPLEMENT_LIMIT): DeliverySupplement[] {
  const recent = [...tasks]
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
  if (!recent.length) return [];
  const older = tasks.length - recent.length;
  return [
    {
      id: "recent-tasks", kind: "recent-tasks", priority: 415,
      text: `RECENT TASKS on ${target} — earlier agent work here, from graph memory (advisory history, not rules): build on what was verified instead of redoing it blind.${older > 0 ? ` ${older} older task(s) not shown; hunch task list.` : ""}`,
    },
    ...recent.map((t, i) => ({ id: t.id, kind: "recent-task", priority: 414 - i, text: describeTaskRecord(t) })),
  ];
}
