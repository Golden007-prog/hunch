/**
 * The shared in-force predicate (round-2 audit #10). The veto, regression,
 * retired-symbol and conformance guards each inlined a weaker `superseded`-only
 * copy, so a decision the team formally REJECTED — or one whose valid-time window
 * had been closed — kept blocking commits and kept injecting "don't re-add this"
 * into the pre-edit hook, with no way to un-stick it short of hand-editing JSON.
 *
 * A `proposed` draft deliberately STILL contributes: its tripwires are llm_draft,
 * which isVetoBlocker can never promote to a block, so it is advisory signal — the
 * curate loop working as designed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInForce, isLive } from "../src/core/topics.js";
import { isVetoBlocker } from "../src/core/strictgate.js";
import { checkConformance, type ConformanceGraph } from "../src/core/conformance.js";
import { tempStore, prov } from "./helpers.js";
import type { Decision } from "../src/core/types.js";

const dec = (over: Partial<Decision>): Decision => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: ["use axios"], rejected_tripwires: [],
  related_components: [], related_files: ["src/api.ts"],
  supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: ["oldHelper"], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  date: "2026-01-01T00:00:00Z",
  ...over,
} as Decision);

test("isInForce excludes rejected and window-closed, keeps proposed (advisory)", () => {
  assert.equal(isInForce(dec({ status: "accepted" })), true);
  assert.equal(isInForce(dec({ status: "proposed" })), true, "a proposed draft is still advisory signal");
  assert.equal(isInForce(dec({ status: "rejected" })), false, "a REJECTED decision must not enforce");
  assert.equal(isInForce(dec({ status: "superseded" })), false);
  assert.equal(isInForce(dec({ superseded_by: "dec_newer" })), false);
  assert.equal(isInForce(dec({ valid_to: "2026-06-01T00:00:00Z" })), false, "a closed valid-time window must not enforce");
  // isLive stays STRICTER (accepted only) — the topic contract is unchanged.
  assert.equal(isLive(dec({ status: "proposed" })), false);
  assert.equal(isLive(dec({ status: "accepted" })), true);
});

test("a REJECTED decision can no longer block via the veto gate (#10)", () => {
  const tw = { provenance: { source: "human_confirmed" } };
  assert.equal(isVetoBlocker(dec({ status: "accepted" }), tw, "dep", false), true, "baseline: in-force + confirmed blocks");
  assert.equal(isVetoBlocker(dec({ status: "rejected" }), tw, "dep", false), false, "a rejected decision must not block");
  assert.equal(isVetoBlocker(dec({ valid_to: "2026-06-01T00:00:00Z" }), tw, "dep", false), false, "a closed window must not block");
});

test("regression + retired-symbol guards ignore a rejected decision (#10)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", dec({ id: "dec_rejected", status: "rejected" }));
    store.reindex();
    // retiredForFile powers the pre-edit hook's "deliberately RETIRED — do not
    // re-introduce" block; a rejected decision must contribute nothing.
    assert.deepEqual(store.retiredForFile("src/api.ts"), [], "no retired note from a rejected decision");
    const hits = store.regressionHits({ symbols: ["oldHelper"], deps: [] }, ["src/api.ts"]);
    assert.deepEqual(hits, [], "re-adding what a REJECTED decision retired is not a regression");

    // Control: the same record accepted DOES drive both guards.
    store.json.put("decisions", dec({ id: "dec_rejected", status: "accepted" }));
    store.reindex();
    assert.equal(store.retiredForFile("src/api.ts").length, 1);
    assert.equal(store.regressionHits({ symbols: ["oldHelper"], deps: [] }, ["src/api.ts"]).length, 1);
  } finally {
    cleanup();
  }
});

test("conformance ignores a rejected decision's predicates (#10)", () => {
  const { store, cleanup } = tempStore();
  try {
    const graph: ConformanceGraph = {
      symbols: [{ id: "sym_a", file: "src/api.ts", name: "handler", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" }] as never,
      edges: [] as never,
    };
    // `exists` on a symbol that is NOT in the graph → violated, if it counts at all.
    const pred = [{ assert: "exists", subject: "goneSymbol", transitive: false }];
    store.json.put("decisions", dec({ id: "dec_rej_conf", status: "rejected", conformance: pred } as never));
    assert.deepEqual(checkConformance(store, { graph }), [], "a rejected decision states no intent to conform to");

    store.json.put("decisions", dec({ id: "dec_rej_conf", status: "accepted", conformance: pred } as never));
    const results = checkConformance(store, { graph });
    assert.equal(results.length, 1, "control: an accepted decision's predicate IS evaluated");
    assert.equal(results[0]!.satisfied, false);
    void prov;
  } finally {
    cleanup();
  }
});
