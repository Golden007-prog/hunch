import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEIGHTS, outcomeTerm, rankTaskRecord, rankTaskRecords, recencyTerm, selectTaskSlots, taskSimilarity, type RankingContext, type RankingQuery } from "../src/core/taskRanking.js";
import { reportHash } from "../src/core/taskReport.js";
import { TaskRecordSchema, type TaskRecord } from "../src/core/types.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function rec(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return TaskRecordSchema.parse({
    id: `htask_${id.padEnd(24, "0").slice(0, 24)}`, title: `Task ${id}`, state: "completed",
    started_at: over.finished_at ?? day(1), finished_at: day(1), coverage: "delivered",
    lessons: [], applied: [], saved: [], checks: [], conformance: [], refusals: 0, files: ["src/config.js"],
    report_hash: reportHash(id), provenance: { source: "task_report", confidence: 1, evidence: [] },
    ...over,
  });
}
const lesson = (record_id: string) => ({ kind: "constraints", record_id, content_hash: reportHash(record_id), title: record_id });
const query = (over: Partial<RankingQuery> = {}): RankingQuery => ({ target: "src/config.js", files: new Set(), recordIds: new Set(), phrase: null, now: NOW, ...over });
function ctx(over: Partial<RankingContext> = {}): RankingContext {
  const df: Record<string, number> = { con_common: 80, con_rare: 3, dec_x: 1 };
  const N = 100;
  return {
    dependents: new Set(), cochange: new Map(), lexical: new Map(), anchorsAlive: () => 1,
    ruleStats: (id) => ({ df: df[id] ?? 0, idf: Math.log(N / Math.max(1, df[id] ?? 1)) }),
    ...over,
  };
}

test("gate: structure or a shared rule admits; lexical, recency or outcome alone never do", () => {
  const c = ctx({ lexical: new Map([["htask_lex00000000000000000000", 1]]) });
  assert.ok(rankTaskRecord(rec("same"), query(), c), "same file admits");
  assert.ok(rankTaskRecord(rec("dep", { files: ["src/dep.js"] }), query(), ctx({ dependents: new Set(["src/dep.js"]) })), "dependent admits");
  assert.ok(rankTaskRecord(rec("co", { files: ["src/other.js"] }), query(), ctx({ cochange: new Map([["src/other.js", { count: 3, strength: 0.4 }]]) })), "co-change admits");
  assert.equal(rankTaskRecord(rec("co1", { files: ["src/other.js"] }), query(), ctx({ cochange: new Map([["src/other.js", { count: 1, strength: 0.9 }]]) })), null, "a single co-change commit is noise");
  assert.ok(rankTaskRecord(rec("rule", { files: ["src/elsewhere.js"], lessons: [lesson("con_rare")] }), query({ recordIds: new Set(["con_rare"]) }), c), "shared rule admits from another file");
  assert.equal(rankTaskRecord(rec("lex", { files: ["src/elsewhere.js"] }), query({ phrase: "config" }), c), null, "lexical alone never admits");
  assert.equal(rankTaskRecord(rec("ubiq", { files: ["src/elsewhere.js"], lessons: [lesson("con_common")] }), query({ recordIds: new Set(["con_common"]) }), c), null, "a rule shared by most tasks is not evidence of relatedness");
  assert.equal(rankTaskRecord(rec("viol", { files: ["src/elsewhere.js"], conformance: [{ kind: "constraints", record_id: "con_x", content_hash: reportHash("x"), outcome: "violated" }] }), query(), c), null, "outcome alone never admits");
  assert.equal(rankTaskRecord(rec("gone"), query(), ctx({ anchorsAlive: () => 0 })), null, "a record whose files are all gone is excluded");
});

test("terms at their boundaries: file tiers, IDF-weighted rules, outcome ladder, recency floor, working set", () => {
  const q = query({ recordIds: new Set(["con_common", "con_rare"]), files: new Set(["src/config.js", "src/b.js"]) });
  const same = rankTaskRecord(rec("s"), q, ctx())!;
  assert.equal(same.terms.file, 1);
  assert.equal(same.terms.workingSet, 0.5, "one of the two files this task touched");
  assert.equal(rankTaskRecord(rec("d", { files: ["src/dep.js"] }), q, ctx({ dependents: new Set(["src/dep.js"]) }))!.terms.file, 0.5);
  assert.equal(rankTaskRecord(rec("c", { files: ["src/o.js"] }), q, ctx({ cochange: new Map([["src/o.js", { count: 2, strength: 0.2 }]]) }))!.terms.file, 0.3);

  const common = rankTaskRecord(rec("rc", { lessons: [lesson("con_common")] }), q, ctx())!;
  const rare = rankTaskRecord(rec("rr", { lessons: [lesson("con_rare")] }), q, ctx())!;
  assert.ok(rare.terms.rules > common.terms.rules * 5, `a rare shared rule outweighs a ubiquitous one (${rare.terms.rules} vs ${common.terms.rules})`);
  assert.ok(rare.terms.rules <= 1 && common.terms.rules >= 0);
  assert.match(rare.reasons.join(" | "), /shares con_rare \(3 tasks\)/);

  assert.deepEqual(outcomeTerm(rec("v", { conformance: [{ kind: "constraints", record_id: "con_x", content_hash: reportHash("x"), outcome: "violated" }], checks: [{ label: "t", state: "failed", exit_code: 1 }] })), { value: 1, reason: "RULE VIOLATED" });
  assert.equal(outcomeTerm(rec("f", { checks: [{ label: "t", state: "failed", exit_code: 1 }] })).value, 0.8);
  assert.equal(outcomeTerm(rec("sv", { saved: [{ kind: "decisions", record_id: "dec_x", content_hash: reportHash("d"), home: "public", operation: "created", durability: "committed" }] })).value, 0.6);
  assert.equal(outcomeTerm(rec("ap", { applied: [{ record_id: "con_x", content_hash: reportHash("x"), action: "kept it", supported_by: "hev_000000000000000000000001" }] })).value, 0.5);
  assert.equal(outcomeTerm(rec("pa", { checks: [{ label: "t", state: "passed", exit_code: 0 }] })).value, 0.3);
  assert.equal(outcomeTerm(rec("plain")).value, 0);

  assert.ok(Math.abs(recencyTerm(rec("r0", { finished_at: day(0) }), NOW) - 1) < 1e-9);
  assert.ok(Math.abs(recencyTerm(rec("r30", { finished_at: day(30) }), NOW) - 0.5) < 1e-9, "half-life 30 days");
  assert.equal(recencyTerm(rec("r900", { finished_at: day(900) }), NOW), 0.1, "floor keeps old structural matches alive");
});

test("score is a convex sum with the default weights and the sort is deterministic: score, then newest, then id", () => {
  const a = rec("a", { finished_at: day(2) }), b = rec("b", { finished_at: day(2) }), c = rec("c", { finished_at: day(1) });
  const ranked = rankTaskRecords([b, a, c], query(), ctx());
  // identical terms except recency → c (newer) first; a and b tie → id order
  assert.deepEqual(ranked.map((r) => r.record.id), [c.id, a.id, b.id]);
  const r = ranked[0]!;
  const expected = DEFAULT_WEIGHTS.file * 1 + DEFAULT_WEIGHTS.recency * r.terms.recency;
  assert.ok(Math.abs(r.score - expected) < 1e-9, `score ${r.score} vs ${expected}`);
  assert.ok(Object.values(DEFAULT_WEIGHTS).reduce((s, w) => s + w, 0) - 1 < 1e-9, "weights sum to 1");
  const again = rankTaskRecords([c, b, a], query(), ctx());
  assert.deepEqual(again.map((x) => x.record.id), ranked.map((x) => x.record.id), "input order does not matter");
});

test("slots: latest on the exact file is guaranteed, the newest problem gets its own slot, MMR removes near-duplicates, cap holds", () => {
  const latestPlain = rec("latest", { finished_at: day(0) });
  const oldViolation = rec("viol", { finished_at: day(20), conformance: [{ kind: "constraints", record_id: "con_rare", content_hash: reportHash("x"), outcome: "violated" }], lessons: [lesson("con_rare")] });
  const twinA = rec("twina", { finished_at: day(3), lessons: [lesson("con_rare")], checks: [{ label: "t", state: "passed", exit_code: 0 }] });
  const twinB = rec("twinb", { finished_at: day(3), lessons: [lesson("con_rare")], checks: [{ label: "t", state: "passed", exit_code: 0 }] });
  const other = rec("other", { finished_at: day(5), files: ["src/dep.js"], lessons: [lesson("dec_x")] });
  const far = rec("far", { finished_at: day(40), files: ["src/dep.js"] });
  const ranked = rankTaskRecords([far, twinB, other, twinA, oldViolation, latestPlain], query({ recordIds: new Set(["con_rare", "dec_x"]) }), ctx({ dependents: new Set(["src/dep.js"]) }));
  const sel = selectTaskSlots(ranked);
  assert.equal(sel.picks[0]!.slot, "latest");
  assert.equal(sel.picks[0]!.ranked.record.id, latestPlain.id, "newest exact-file record, regardless of score");
  assert.equal(sel.picks[1]!.slot, "violation");
  assert.equal(sel.picks[1]!.ranked.record.id, oldViolation.id, "an old violation still gets the slot");
  assert.equal(sel.picks.length, 5);
  assert.equal(sel.more, 1);
  const relevant = sel.picks.slice(2).map((p) => p.ranked.record.id);
  assert.ok(relevant.includes(other.id), "a different cluster (dependent file, different rule) is preferred over a twin");
  assert.ok(!(relevant.includes(twinA.id) && relevant.includes(twinB.id)) || relevant.length === 3, "MMR does not pick both twins before a different cluster");
  assert.ok(taskSimilarity(twinA, twinB) === 1 && taskSimilarity(twinA, other) < 0.5);
  const capped = selectTaskSlots(ranked, { limit: 2 });
  assert.deepEqual(capped.picks.map((p) => p.slot), ["latest", "violation"]);
  assert.equal(capped.more, ranked.length - 2);
});

test("reasons are factual and ordered by contribution; anchors that moved are flagged", () => {
  const r = rankTaskRecord(
    rec("why", { finished_at: day(12), lessons: [lesson("con_rare")], saved: [{ kind: "decisions", record_id: "dec_y", content_hash: reportHash("y"), home: "public", operation: "created", durability: "committed" }], files: ["src/config.js", "src/gone.js"] }),
    query({ recordIds: new Set(["con_rare"]), files: new Set(["src/config.js"]), phrase: "settings merge" }),
    ctx({ lexical: new Map([[rec("why").id, 0.8]]), anchorsAlive: () => 0.5 }),
  )!;
  assert.equal(r.reasons[0], "same file");
  assert.ok(r.reasons.includes("shares con_rare (3 tasks)"));
  assert.ok(r.reasons.includes("saved dec_y"));
  assert.ok(r.reasons.includes('matches "settings merge"'));
  assert.ok(r.reasons.includes("also touched src/config.js this task"));
  assert.ok(r.reasons.includes("12 days ago"));
  assert.equal(r.reasons.at(-1), "files since changed");
  assert.equal(r.anchorsAlive, 0.5);
});
