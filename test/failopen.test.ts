/**
 * The fail-open cluster (round-2 audit): four independent guards each treated
 * "cannot evaluate" as "complies". Every test here FAILS against the pre-fix code.
 *
 *  1. content-matched constraints/tripwires were inert on non-code files, because
 *     analyzeDiff dropped their added lines (isCode gate) and buildCheckReport reads
 *     an empty scoped-line set as "cannot prove a violation ⇒ complies";
 *  2. the dep tier checked only the FIRST added specifier matching a forbid, so an
 *     out-of-scope spelling shadowed the real in-scope violation;
 *  3. conformance could never resolve an external package (a virtual ext_ node, not a
 *     Symbol), so every not-imports predicate was a permanent silent green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff } from "../src/extractors/diff.js";
import { matchForbids } from "../src/core/constraintmatch.js";
import { checkConformance, type ConformanceGraph } from "../src/core/conformance.js";
import { externalImportNodeId } from "../src/core/externalImports.js";
import { tempStore, prov } from "./helpers.js";

const diffFor = (file: string, added: string[]): string => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  `@@ -1,0 +1,${added.length} @@`,
  ...added.map((l) => `+${l}`),
].join("\n");

test("analyzeDiff captures added lines for NON-CODE files so content matchers can see them (#3)", () => {
  const a = analyzeDiff(diffFor(".github/workflows/ci.yml", ["  AWS_SECRET: hardcoded-key-here"]));
  assert.deepEqual(
    a.addedLinesByFile.get(".github/workflows/ci.yml"),
    ["  AWS_SECRET: hardcoded-key-here"],
    "a blocking rule scoped to .github/workflows/** must be able to see the line that breaks it",
  );
  // Code-only accounting is deliberately unchanged: a .yml line is not a symbol,
  // not an import, and does not count toward churn.
  assert.deepEqual(a.addedSymbols, []);
  assert.deepEqual(a.addedDeps, []);
});

test("a content-matched BLOCKING constraint fires on a non-code file end to end (#3)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("constraints", {
      id: "con_ci_secret", type: "security",
      statement: "CI workflows must never hardcode a cloud secret",
      scope: [".github/workflows/**"], severity: "blocking", enforcement: "advisory_v1",
      match: null, forbids: { deps: [], symbols: [], patterns: ["AWS_SECRET:\\s*\\S"] },
      rationale: "", source_decision: null, violations: [], status: "active",
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    } as never);
    store.reindex();

    const file = ".github/workflows/ci.yml";
    const report = store.buildCheckReport([file], diffFor(file, ["  AWS_SECRET: hardcoded-key-here"]), { strict: true });
    assert.equal(report.direct.length, 1, "the violated invariant must appear in the direct report, not be dropped as compliant");
    assert.equal(report.direct[0]!.id, "con_ci_secret");
    assert.equal(report.strictBlockers, 1, "and it must block under --strict, matching what the pre-edit hook already denies");

    // The other half of the contract still holds: touching the scope WITHOUT tripping
    // the rule stays silent (no false positive).
    const clean = store.buildCheckReport([file], diffFor(file, ["  NODE_VERSION: 22"]), { strict: true });
    assert.equal(clean.direct.length, 0);
  } finally {
    cleanup();
  }
});

test("the dep tier checks EVERY matching added specifier, not just the first (#4)", () => {
  const forbids = { deps: ["lodash"], symbols: [], patterns: [] };
  // One commit: an out-of-scope file adds bare `lodash`, the SCOPED file adds a
  // submodule. Set iteration hands the bare spelling over first; the old `.find`
  // stopped there, importsDep failed against the submodule line, and the blocking
  // rule silently passed.
  const addedDeps = new Set(["lodash", "lodash/groupBy"]);
  const scopedAdded = ['import groupBy from "lodash/groupBy";'];
  const hit = matchForbids(forbids, addedDeps, scopedAdded);
  assert.ok(hit, "the in-scope submodule import must be caught regardless of diff order");
  assert.equal(hit.tier, "dep");

  // Order-independence is the actual invariant — assert the mirrored set too.
  const mirrored = matchForbids(forbids, new Set(["lodash/groupBy", "lodash"]), scopedAdded);
  assert.ok(mirrored, "verdict must not depend on the order of an unrelated file in the same commit");

  // And a scope that imports NOTHING forbidden still complies.
  assert.equal(matchForbids(forbids, addedDeps, ['import x from "./local.js";']), null);
});

test("not-imports resolves an EXTERNAL package and catches the violating edge (#7)", () => {
  const extId = externalImportNodeId("express")!;
  const graph: ConformanceGraph = {
    symbols: [
      { id: "sym_order", file: "src/order.ts", name: "Order", kind: "class", signature_hash: "", calls: [], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
    ] as never,
    edges: [
      { id: "e1", from: "sym_order", to: extId, type: "imports", reason: "src/order.ts imports external package express", strength: 1, provenance: prov() },
    ] as never,
  };
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", {
      id: "dec_no_http_in_domain", title: "the domain layer stays HTTP-agnostic",
      status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [],
      rejected_tripwires: [], related_components: [], related_files: [],
      supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
      retired: { symbols: [], deps: [] },
      conformance: [{ assert: "not-imports", subject: "Order", object: "express", transitive: false }],
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
      date: "2026-08-05T00:00:00Z",
    } as never);

    const violated = checkConformance(store, { graph }).filter((c) => !c.satisfied);
    assert.equal(violated.length, 1, "the graph records the violating imports edge — the predicate must report VIOLATED, not a silent green");
    assert.match(violated[0]!.detail, /now reaches/);

    // Remove the edge: nothing reaches express, so the forbidden relation genuinely holds.
    const clean = checkConformance(store, { graph: { symbols: graph.symbols, edges: [] } }).filter((c) => !c.satisfied);
    assert.equal(clean.length, 0, "with no such import the predicate is satisfied — no false positive");
  } finally {
    cleanup();
  }
});
