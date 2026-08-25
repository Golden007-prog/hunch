import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileFirstDeclarationClusters,
  buildProgressiveDeclarationPlan,
  FILE_FIRST_CLUSTER_LIMIT,
  FILE_FIRST_DECLARATION_CLUSTER_RULE,
  FILE_FIRST_FILE_LIMIT,
  FILE_FIRST_MEMBER_LIMIT,
  PROGRESSIVE_DECLARATION_PLAN_RULE,
  PROGRESSIVE_DECLARATION_TOTAL_LIMIT,
} from "../src/core/declarationClusters.js";

const candidate = (owner: string, score: number, typeScaffolding = false) => ({
  owner,
  score,
  runtime_declaration: !typeScaffolding,
  type_scaffolding: typeScaffolding,
});

test("file-first clustering collapses declaration scaffolding into a semantic family", () => {
  const ranked = [
    candidate("src/schemas.ts::$ZodTemplateLiteral", 80),
    candidate("src/schemas.ts::$PartsToTemplateLiteral", 79, true),
    candidate("src/schemas.ts::$ZodTemplateLiteralDef", 78, true),
    candidate("src/schemas.ts::$ZodEnum", 77),
    candidate("src/schemas.ts::$ZodRecord", 76),
    candidate("src/facade.ts::templateLiteral", 75),
  ];
  const output = buildFileFirstDeclarationClusters(ranked);
  const schemas = output.files.find((file) => file.path === "src/schemas.ts");
  assert.ok(schemas);
  assert.deepEqual(schemas.declaration_clusters.map((cluster) => cluster.label), [
    "template / literal",
    "enum",
  ]);
  assert.deepEqual(schemas.declaration_clusters[0]?.members.map((member) => member.owner), [
    "src/schemas.ts::$ZodTemplateLiteral",
    "src/schemas.ts::$PartsToTemplateLiteral",
    "src/schemas.ts::$ZodTemplateLiteralDef",
  ]);
  assert.equal(schemas.declaration_clusters[0]?.members_truncated, 0);
  assert.equal(schemas.declaration_clusters[1]?.members[0]?.owner, "src/schemas.ts::$ZodEnum");
});

test("file-first clustering is deterministic, bounded, and preserves uncertainty", () => {
  const ranked = Array.from({ length: 8 }, (_, fileIndex) =>
    Array.from({ length: 20 }, (_, memberIndex) => candidate(
      `src/file-${fileIndex}.ts::policy${memberIndex}`,
      1_000 - fileIndex * 100 - memberIndex,
    ))).flat();
  const first = buildFileFirstDeclarationClusters(ranked);
  const second = buildFileFirstDeclarationClusters(ranked);
  assert.equal(first.receipt.rule, FILE_FIRST_DECLARATION_CLUSTER_RULE);
  assert.equal(first.receipt.receipt_id, second.receipt.receipt_id);
  assert.equal(first.receipt.flat_shortlist_preserved, true);
  assert.equal(first.receipt.file_selection_strategy, "flat-shortlist-file-anchor");
  assert.equal(first.receipt.exact_owner_enabled, false);
  assert.equal(first.transfer_calibration.decision, "promoted-supplemental-diagnostic");
  assert.equal(first.transfer_calibration.combined_improvement_points, 0.25);
  assert.ok(first.files.length <= FILE_FIRST_FILE_LIMIT);
  assert.ok(first.files.every((file) => file.declaration_clusters.length <= FILE_FIRST_CLUSTER_LIMIT));
  assert.ok(first.files.every((file) => file.declaration_clusters.every((cluster) =>
    cluster.members.length <= FILE_FIRST_MEMBER_LIMIT)));
  assert.match(first.receipt.receipt_id, /^[a-f0-9]{24}$/);
});

test("progressive inspection preserves the flat shortlist and caps semantic expansion at eleven", () => {
  const ranked = [
    candidate("src/a.ts::alpha", 100),
    candidate("src/b.ts::beta", 99),
    candidate("src/c.ts::gamma", 98),
    candidate("src/d.ts::delta", 97),
    candidate("src/e.ts::epsilon", 96),
    candidate("src/a.ts::alphaRuntime", 95),
    candidate("src/b.ts::betaRuntime", 94),
    candidate("src/c.ts::gammaRuntime", 93),
    candidate("src/d.ts::deltaRuntime", 92),
    candidate("src/e.ts::epsilonRuntime", 91),
    candidate("src/a.ts::alphaInternals", 90, true),
    candidate("src/b.ts::betaInternals", 89, true),
    candidate("src/c.ts::unrelated", 88),
  ];
  const clusters = buildFileFirstDeclarationClusters(ranked);
  const first = buildProgressiveDeclarationPlan(ranked, clusters);
  const second = buildProgressiveDeclarationPlan(ranked, clusters);

  assert.equal(first.receipt.rule, PROGRESSIVE_DECLARATION_PLAN_RULE);
  assert.equal(first.receipt.receipt_id, second.receipt.receipt_id);
  assert.equal(first.receipt.total_limit, PROGRESSIVE_DECLARATION_TOTAL_LIMIT);
  assert.equal(first.receipt.flat_shortlist_preserved, true);
  assert.equal(first.receipt.rejected_rerankers_disabled, true);
  assert.equal(first.receipt.exact_owner_enabled, false);
  assert.deepEqual(first.candidates.slice(0, 5).map((entry) => entry.owner), ranked.slice(0, 5).map((entry) => entry.owner));
  assert.ok(first.candidates.length <= PROGRESSIVE_DECLARATION_TOTAL_LIMIT);
  assert.deepEqual(first.phases.map((phase) => phase.phase), [
    "flat-shortlist",
    "cluster-expansion",
    "cluster-fallback",
  ]);
  assert.ok(first.phases[2]!.candidates.length <= 1);
  assert.equal(first.transfer_calibration.progressive_plan_hits, 5);
  assert.equal(first.transfer_calibration.losses, 0);
  assert.equal(first.transfer_calibration.inspection_reduction, 0.4185);
  assert.equal(first.transfer_calibration.decision, "retain-efficiency-advisory-v4");
  assert.equal(first.transfer_calibration.accuracy_promotion, "rejected-no-fresh-rescue");
  assert.match(first.receipt.receipt_id, /^[a-f0-9]{24}$/);
});
