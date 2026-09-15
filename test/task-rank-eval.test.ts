import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCases, evaluateTaskRanking, groundTruth, latest3Ranker, pairedBootstrap, rankedRanker, renderRankEval } from "../src/core/taskRankEval.js";
import { taskRecordStats } from "../src/core/taskRecordStats.js";
import { reportHash } from "../src/core/taskReport.js";
import { TaskRecordSchema, type TaskRecord } from "../src/core/types.js";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
let seq = 0;
function rec(over: Partial<TaskRecord> & { finished_at: string }): TaskRecord {
  const id = `htask_${String(++seq).padStart(24, "0")}`;
  return TaskRecordSchema.parse({
    id, title: over.title ?? `Task ${seq}`, state: "completed", started_at: over.finished_at, coverage: "delivered",
    lessons: [], applied: [], saved: [], checks: [], conformance: [], refusals: 0, files: ["src/config.js"],
    report_hash: reportHash(id), provenance: { source: "task_report", confidence: 1, evidence: [] },
    ...over,
  });
}
const lesson = (record_id: string) => ({ kind: "constraints", record_id, content_hash: reportHash(record_id), title: `Rule ${record_id}` });
const applied = (record_id: string) => ({ record_id, content_hash: reportHash(record_id), action: "applied it", supported_by: null });
const violated = (record_id: string) => ({ kind: "constraints" as const, record_id, content_hash: reportHash(record_id), outcome: "violated" as const });
const check = (label: string, state: "passed" | "failed" = "passed") => ({ label, state, exit_code: state === "passed" ? 0 : 1 });

test("ground truth: an older task counts when T applied a record it carried, re-ran its check on an overlapping file, or received its violated rule", () => {
  const a = rec({ finished_at: at(1), lessons: [lesson("con_x")] });
  const b = rec({ finished_at: at(2), checks: [check("npm test")] });
  const c = rec({ finished_at: at(3), files: ["src/other.js"], checks: [check("npm test")] });
  const d = rec({ finished_at: at(4), conformance: [violated("con_v")], files: ["src/z.js"] });
  const e = rec({ finished_at: at(5) });
  const t = rec({ finished_at: at(10), applied: [applied("con_x")], checks: [check("npm test")], lessons: [lesson("con_v")] });
  const truth = groundTruth(t, [a, b, c, d, e]);
  assert.deepEqual([...truth].sort(), [a.id, b.id, d.id].sort(), "c has no overlapping file; e proves nothing");
});

test("ranked beats latest3 when the useful task is older than three unrelated recent edits, and the bootstrap is deterministic", () => {
  const records: TaskRecord[] = [];
  // Ten independent cases on ten files: an old task carrying the rule, three newer noise tasks, then T which applied the rule.
  for (let i = 0; i < 10; i++) {
    const file = `src/f${i}.js`;
    const useful = rec({ finished_at: at(100 * i + 1), files: [file], lessons: [lesson(`con_r${i}`)], checks: [check("suite")] });
    for (let k = 0; k < 3; k++) records.push(rec({ finished_at: at(100 * i + 2 + k), files: [file], title: "Rename things" }));
    records.push(useful);
    records.push(rec({ finished_at: at(100 * i + 10), files: [file], lessons: [lesson(`con_r${i}`)], applied: [applied(`con_r${i}`)], title: "Apply the rule" }));
  }
  const cases = buildCases(records);
  assert.equal(cases.length, 10);
  for (const c of cases) {
    assert.equal(latest3Ranker(c).some((id) => c.truth.has(id)), false, "latest3 shows only the three noise tasks");
    assert.equal(rankedRanker()(c).some((id) => c.truth.has(id)), true, "the shared rule pulls the useful task into the slots");
  }
  const report = evaluateTaskRanking(records, { split: 0.3 });
  assert.equal(report.rankers[0]!.name, "ranked");
  assert.equal(report.rankers[0]!.hit5, 1);
  assert.equal(report.rankers[1]!.hit5, 0);
  assert.match(report.split.note ?? "", /evaluated every case/, "3 cases in the newest 30% fall back to all 10");
  assert.equal(report.verdict, "ranked-better", "10 cases with a constant win give a CI above zero");
});

test("verdict logic and the split fallback", () => {
  const records: TaskRecord[] = [];
  for (let i = 0; i < 20; i++) {
    const file = `src/g${i}.js`;
    records.push(rec({ finished_at: at(50 * i + 1), files: [file], lessons: [lesson(`con_g${i}`)] }));
    for (let k = 0; k < 3; k++) records.push(rec({ finished_at: at(50 * i + 2 + k), files: [file] }));
    records.push(rec({ finished_at: at(50 * i + 10), files: [file], lessons: [lesson(`con_g${i}`)], applied: [applied(`con_g${i}`)] }));
  }
  const report = evaluateTaskRanking(records, { split: 0.3 });
  assert.equal(report.evaluable, 20);
  assert.equal(report.split.evaluated, 6, "newest 30% of 20 cases");
  assert.equal(report.split.note, null);
  assert.equal(report.verdict, "ranked-better");
  assert.ok(report.delta_hit5.ci95[0] > 0);
  const again = evaluateTaskRanking(records, { split: 0.3 });
  assert.deepEqual(again.delta_hit5, report.delta_hit5, "seeded bootstrap is byte-stable");
  const tiny = evaluateTaskRanking(records.slice(0, 10), { split: 0.3 });
  assert.match(tiny.split.note ?? "", /evaluated every case/);
  assert.equal(tiny.verdict, "insufficient-data");
  assert.match(renderRankEval(report), /ranked\s+Hit@5 100%/);
  assert.match(renderRankEval(report), /verdict: ranked-better/);
});

test("paired bootstrap: identical rankers give a zero-centred interval; a constant win gives a strictly positive one", () => {
  const same = pairedBootstrap([1, 0, 1, 0, 1, 1], [1, 0, 1, 0, 1, 1]);
  assert.deepEqual(same, { mean: 0, ci95: [0, 0] });
  const win = pairedBootstrap([1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]);
  assert.equal(win.mean, 1);
  assert.deepEqual(win.ci95, [1, 1]);
  const mixed = pairedBootstrap([1, 1, 1, 0, 1, 1, 1, 0], [0, 1, 0, 0, 1, 0, 0, 1]);
  assert.ok(mixed.ci95[0] <= mixed.mean && mixed.mean <= mixed.ci95[1]);
});

test("record stats: re-verification within the window and repeat violations, from task records alone", () => {
  const a = rec({ finished_at: at(0), checks: [check("npm test")], conformance: [violated("con_v")] });
  const b = rec({ finished_at: at(2), checks: [check("npm test")], lessons: [lesson("con_v")] });                 // re-verified, exposed, not repeated
  const c = rec({ finished_at: at(4), checks: [check("lint")], lessons: [lesson("con_v")], conformance: [violated("con_v")] }); // not re-verified, repeated
  const d = rec({ finished_at: at(100), checks: [check("npm test")], files: ["src/elsewhere.js"] });              // no overlap: not a candidate
  const e = rec({ finished_at: at(200), checks: [check("npm test")] });                                           // overlap but outside the 24h window: not a re-verify candidate
  const s = taskRecordStats([e, d, c, b, a], 24);
  assert.equal(s.records, 5);
  assert.equal(s.reverify_candidates, 2, "b and c had an earlier overlapping check within 24h");
  assert.equal(s.reverified, 1);
  assert.equal(s.reverification_rate, 0.5);
  assert.equal(s.violation_candidates, 2, "b and c received con_v after it was violated");
  assert.equal(s.repeated_violations, 1);
  assert.equal(s.repeat_violation_rate, 0.5);
});
