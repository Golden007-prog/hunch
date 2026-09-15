/** Online proxies for whether delivered task history is doing its job,
 * computed from task records alone (no agent claims):
 *  - re-verification: a later task on an overlapping file re-ran a check with
 *    the same label as an earlier task within a window;
 *  - repeat violation: a rule violated in an earlier task was violated again
 *    in a later task on an overlapping file.
 * Both should fall if the RECENT TASKS lines are read and acted on. */
import { normalizePath } from "./taskRanking.js";
import type { TaskRecord } from "./types.js";

export interface TaskRecordStats {
  records: number;
  /** Later tasks that had a chance to re-verify (an earlier overlapping task with a check within the window). */
  reverify_candidates: number;
  reverified: number;
  reverification_rate: number | null;
  /** Later tasks that received a rule an earlier overlapping task violated. */
  violation_candidates: number;
  repeated_violations: number;
  repeat_violation_rate: number | null;
  window_hours: number;
}

export function taskRecordStats(records: readonly TaskRecord[], windowHours = 24): TaskRecordStats {
  const sorted = [...records].filter((r) => r.state === "completed").sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.id.localeCompare(b.id));
  const windowMs = windowHours * 3_600_000;
  let reverifyCandidates = 0, reverified = 0, violationCandidates = 0, repeated = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const files = new Set(t.files.map(normalizePath));
    const tEnd = Date.parse(t.finished_at) || 0;
    const overlapping = sorted.slice(0, i).filter((o) => o.files.some((f) => files.has(normalizePath(f))));
    if (!overlapping.length) continue;
    const recent = overlapping.filter((o) => tEnd - (Date.parse(o.finished_at) || 0) <= windowMs);
    const earlierLabels = new Set(recent.flatMap((o) => o.checks.map((c) => c.label)));
    if (earlierLabels.size) {
      reverifyCandidates++;
      if (t.checks.some((c) => earlierLabels.has(c.label))) reverified++;
    }
    const violatedBefore = new Set(overlapping.flatMap((o) => o.conformance.filter((c) => c.outcome === "violated").map((c) => c.record_id)));
    const received = new Set(t.lessons.map((l) => l.record_id));
    const exposed = [...violatedBefore].filter((id) => received.has(id));
    if (exposed.length) {
      violationCandidates++;
      if (t.conformance.some((c) => c.outcome === "violated" && violatedBefore.has(c.record_id))) repeated++;
    }
  }
  return {
    records: sorted.length,
    reverify_candidates: reverifyCandidates, reverified,
    reverification_rate: reverifyCandidates ? reverified / reverifyCandidates : null,
    violation_candidates: violationCandidates, repeated_violations: repeated,
    repeat_violation_rate: violationCandidates ? repeated / violationCandidates : null,
    window_hours: windowHours,
  };
}
