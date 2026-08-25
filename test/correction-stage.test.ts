import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnoseIssueCorrectionStage,
  EVIDENCE_GUIDED_SHORTLIST_RULE,
  formatCorrectionStageDiagnostic,
  inferIssueCorrectionStage,
  optimizeIssueCorrectionCandidates,
  rankIssueCorrectionStageCandidates,
  reserveEvidenceGuidedOwners,
  reserveExecutionGuidedFileOwner,
  selectGuardedExecutionBridge,
} from "../src/core/correctionStage.js";
import { compileVerifiedEvidenceMap } from "../src/core/evidenceMap.js";

const sources = [{
  path: "packages/lib/src/to-json-schema.ts",
  content: [
    "export function toJSONSchema(value: unknown) { return resolveReferences(value); }",
    "export interface ReferenceOptions { target: string; }",
    "export function resolveReferences(value: unknown) { // assemble nested reference pointers and definitions",
    "  return value;",
    "}",
    "export function assembleDefinitions(value: unknown) { return value; }",
  ].join("\n"),
}];

test("correction-stage classifier routes contract language to the owning layer", () => {
  assert.equal(inferIssueCorrectionStage("fromJSONSchema loses a property"), "schema-ingestion");
  assert.equal(inferIssueCorrectionStage("toJSONSchema emits a broken $ref"), "schema-emission");
  assert.equal(inferIssueCorrectionStage("the error message wording is wrong in the locale"), "presentation");
  assert.equal(inferIssueCorrectionStage("the minimum constraint has the wrong origin"), "constraint-definition");
  assert.equal(inferIssueCorrectionStage("optional objects accept the wrong runtime value"), "runtime-policy");
});

test("correction-stage ranking excludes an invoked public entrance and favors runtime declarations", () => {
  const issue = "toJSONSchema(value) emits a $ref whose nested reference pointer is missing from $defs; reference resolution must assemble the definitions.";
  const ranked = rankIssueCorrectionStageCandidates(issue, sources);
  assert.ok([
    "packages/lib/src/to-json-schema.ts::resolveReferences",
    "packages/lib/src/to-json-schema.ts::assembleDefinitions",
  ].includes(ranked[0]?.owner ?? ""));
  assert.ok(!ranked.some((candidate) => candidate.owner.endsWith("::toJSONSchema")));
  assert.equal(ranked[0]?.runtime_declaration, true);
});

test("correction-stage diagnostic caps the shortlist and states calibrated uncertainty", () => {
  const issue = "toJSONSchema(value) emits a $ref whose reference pointer is missing from $defs.";
  const diagnostic = diagnoseIssueCorrectionStage(issue, sources, 99);
  assert.ok(diagnostic.candidates.length <= 5);
  assert.equal(diagnostic.exact_owner_enabled, false);
  assert.equal(diagnostic.likely_file, "packages/lib/src/to-json-schema.ts");
  assert.equal(diagnostic.file_first_declaration_clusters.receipt.flat_shortlist_preserved, true);
  assert.equal(diagnostic.file_first_declaration_clusters.receipt.exact_owner_enabled, false);
  assert.match(diagnostic.file_first_declaration_clusters.receipt.receipt_id, /^[a-f0-9]{24}$/);
  assert.equal(diagnostic.progressive_inspection.receipt.flat_shortlist_preserved, true);
  assert.equal(diagnostic.progressive_inspection.receipt.rejected_rerankers_disabled, true);
  assert.ok(diagnostic.progressive_inspection.candidates.length <= 11);
  assert.match(diagnostic.progressive_inspection.receipt.receipt_id, /^[a-f0-9]{24}$/);
  assert.deepEqual(diagnostic.calibration, {
    holdout_tasks: 11,
    likely_file_hits: 9,
    top_five_hits: 8,
  });
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /exact-owner claims are disabled/i);
  assert.deepEqual(diagnostic.cross_repository_transfer, {
    repositories: ["jquense/yup", "sinclairzx81/typebox"],
    holdout_tasks: 16,
    likely_file_hits: 0,
    top_five_hits: 0,
    decision: "rejected",
  });
  assert.deepEqual(diagnostic.adaptive_transfer, {
    repositories: ["arktypeio/arktype", "typestack/class-validator"],
    scorable_tasks: 11,
    likely_file_hits: 8,
    top_five_hits: 9,
    exact_symbol_hits: 7,
    decision: "promoted-diagnostic",
  });
  assert.deepEqual(diagnostic.adaptive_replication, {
    repositories: ["trpc/trpc", "elysiajs/elysia"],
    scorable_tasks: 11,
    likely_file_hits: 4,
    top_five_hits: 5,
    exact_symbol_hits: 4,
    decision: "failed-replication",
  });
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /evidence is mixed/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /per-case confidence.*disabled/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /bounded inspection families, not exact-owner claims/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /preserved union 6\/12.*\+25 points/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /progressive inspection plan/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /41\.9%.*efficiency advisory/i);
  assert.match(formatCorrectionStageDiagnostic(diagnostic), /rejected evidence and causal-owner rerankers/i);
  assert.equal(diagnostic.optimization_policy.active.some((entry) =>
    entry.mechanism === "progressive-inspection-budget"), false);
  assert.equal(diagnostic.optimization_policy.advisory_only.some((entry) =>
    entry.mechanism === "progressive-inspection-budget"), true);
  assert.equal(diagnostic.optimization_policy.disabled.some((entry) =>
    entry.mechanism === "evidence-guided-reordering"), true);
  assert.equal(diagnostic.optimization_policy.disabled.some((entry) =>
    entry.mechanism === "additive-same-file-frontier"), true);
});

test("evidence-guided reserve promotes bounded behavior-sensitive candidates while preserving baseline slots", () => {
  const claim = "the emitted schema loses a nested reference";
  const map = compileVerifiedEvidenceMap({
    version: 1,
    claim,
    probe: { target_before: "red", control_before: "green" },
    execution: [],
    interventions: [
      { owner: "src/internal.ts::assemble", target_after: "green", control_after: "green" },
      { owner: "src/internal.ts::finalize", target_after: "green", control_after: "green" },
    ],
  });
  const baseline = ["src/public.ts::convert", "src/public.ts::emit", "src/core.ts::parse", "src/core.ts::walk", "src/core.ts::visit"];
  const ranked = [...baseline, "src/internal.ts::assemble", "src/internal.ts::peer", "src/internal.ts::finalize"];
  const optimized = reserveEvidenceGuidedOwners(baseline, ranked, map, 5);
  assert.deepEqual(optimized, [
    "src/internal.ts::assemble",
    "src/internal.ts::finalize",
    "src/internal.ts::peer",
    "src/public.ts::convert",
    "src/public.ts::emit",
  ]);
  assert.equal(optimized.filter((owner) => baseline.includes(owner)).length, 2);
});

test("production optimizer emits a deterministic receipt and never applies mismatched or unverified evidence", () => {
  const issue = "toJSONSchema(value) emits a $ref whose nested reference pointer is missing from $defs; reference resolution must assemble the definitions.";
  const extraSources = [{
    path: "packages/lib/src/json-schema-processors.ts",
    content: [
      "export function applyReferencePolicy(value: unknown) { return value; }",
      "export function finalizeReferences(value: unknown) { return value; }",
    ].join("\n"),
  }];
  const receipt = {
    version: 1,
    claim: issue,
    probe: { target_before: "red", control_before: "green" },
    execution: [],
    interventions: [{
      owner: "packages/lib/src/json-schema-processors.ts::applyReferencePolicy",
      target_after: "green",
      control_after: "green",
    }],
  };
  const first = optimizeIssueCorrectionCandidates(issue, [...sources, ...extraSources], receipt, 5);
  const second = optimizeIssueCorrectionCandidates(issue, [...sources, ...extraSources], receipt, 5);
  assert.equal(first.receipt.rule, EVIDENCE_GUIDED_SHORTLIST_RULE);
  assert.equal(first.receipt.receipt_id, second.receipt.receipt_id);
  assert.equal(first.receipt.probe_authenticated, true);
  assert.equal(first.receipt.claim_bound, true);
  assert.equal(first.receipt.exact_owner_enabled, false);
  assert.equal(first.receipt.applied, false);
  assert.equal(first.receipt.reason, "transfer-rejected-read-only");
  assert.deepEqual(first.receipt.optimized_candidates, first.receipt.baseline_candidates);
  assert.ok(first.candidates.some((candidate) => candidate.evidence.behavior_sensitive_file));

  const mismatch = optimizeIssueCorrectionCandidates(`${issue} changed`, [...sources, ...extraSources], receipt, 5);
  assert.equal(mismatch.receipt.applied, false);
  assert.equal(mismatch.receipt.reason, "claim-mismatch");
  assert.deepEqual(mismatch.receipt.optimized_candidates, mismatch.receipt.baseline_candidates);

  const unverified = optimizeIssueCorrectionCandidates(issue, [...sources, ...extraSources], {
    ...receipt,
    probe: { target_before: "red", control_before: "red" },
  }, 5);
  assert.equal(unverified.receipt.applied, false);
  assert.equal(unverified.receipt.reason, "probe-unverified");
  assert.deepEqual(unverified.receipt.optimized_candidates, unverified.receipt.baseline_candidates);
});

test("execution bridge spends only the fifth slot on a strongly differential file", () => {
  const evidence = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A nested policy must retain a value on one path.",
    probe: { target_before: "red", control_before: "green" },
    execution: [
      { owner: "src/z-target.ts::policyZ", target_count: 6, control_count: 2 },
      { owner: "src/a.ts::policyA", target_count: 3, control_count: 2 },
    ],
    interventions: [],
  });
  const baseline = ["src/a.ts::policyA", "src/b.ts::policyB", "src/c.ts::policyC", "src/d.ts::policyD", "src/e.ts::policyE"];
  const ranked = [...baseline, "src/z-target.ts::policyZ"];
  const optimized = reserveExecutionGuidedFileOwner(baseline, ranked, evidence, 5);
  assert.deepEqual(optimized, [...baseline.slice(0, 4), "src/z-target.ts::policyZ"]);

  const issue = evidence.claim;
  const bridgeSources = ["a", "b", "c", "d", "e"].map((suffix) => ({
    path: `src/${suffix}.ts`,
    content: `export function policy${suffix.toUpperCase()}() { return 'nested policy retain value'; }`,
  })).concat([{
    path: "src/z-target.ts",
    content: "export function policyZ() { return 'nested policy retain value'; }",
  }]);
  const diagnostic = optimizeIssueCorrectionCandidates(issue, bridgeSources, {
    version: 1,
    claim: issue,
    probe: { target_before: "red", control_before: "green" },
    execution: [{ owner: "src/z-target.ts::policyZ", target_count: 6, control_count: 2 }],
    interventions: [],
  }, 5);
  assert.equal(diagnostic.receipt.version, 3);
  assert.equal(diagnostic.receipt.reason, "transfer-rejected-read-only");
  assert.equal(diagnostic.receipt.evidence_strategy, null);
  assert.equal(diagnostic.receipt.applied, false);
  assert.equal(diagnostic.receipt.exact_owner_enabled, false);
  assert.deepEqual(diagnostic.receipt.optimized_candidates, diagnostic.receipt.baseline_candidates);
});

test("execution bridge rejects runtime-heavy owners without static plausibility", () => {
  const baseline = ["src/a.ts::a", "src/b.ts::b", "src/c.ts::c", "src/d.ts::d", "src/e.ts::e"];
  const ranked = [...baseline, ...Array.from({ length: 19 }, (_, index) => `src/filler-${index}.ts::f${index}`), "src/runtime.ts::hotLoop"];
  const evidence = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A bounded runtime path",
    probe: { target_before: "red", control_before: "green" },
    execution: [{ owner: "src/runtime.ts::hotLoop", target_count: 1_000, control_count: 1 }],
    interventions: [],
  });
  assert.equal(selectGuardedExecutionBridge(baseline, ranked, evidence, 5), null);

  const directRanked = [...baseline, "src/runtime.ts::hotLoop"];
  assert.deepEqual(selectGuardedExecutionBridge(baseline, directRanked, evidence, 5), {
    owner: "src/runtime.ts::hotLoop",
    path: "src/runtime.ts",
    strategy: "direct-high-contrast-execution",
    execution_ratio: 1_000,
    static_rank: 6,
  });
});
