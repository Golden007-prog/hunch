import assert from "node:assert/strict";
import { test } from "node:test";
import { rankIssueCausalCorrectionCandidates, rankIssueCausalHybridCandidates } from "../bench/external/adaptive-stage-causal-ranker.js";

test("causal hybrid preserves four adaptive slots and spends one on a reachable orchestrator", () => {
  const sources = [
    { path: "src/public/cookie.ts", content: "export function cookieValue(value: string) { return value; }\n" },
    { path: "src/runtime/compose.ts", content: "import { cookieValue } from '../public/cookie.js';\nexport function composeHandler(value: string) { return cookieValue(value); }\n" },
    { path: "src/runtime/other.ts", content: "export function unrelatedAlpha() {}\nexport function unrelatedBeta() {}\nexport function unrelatedGamma() {}\nexport function unrelatedDelta() {}\n" },
  ];
  const causal = rankIssueCausalCorrectionCandidates("cookieValue(input) returns an invalid cookie string", sources);
  const ranked = rankIssueCausalHybridCandidates("cookieValue(input) returns an invalid cookie string", sources);
  assert.equal(ranked.length, 5);
  assert.equal(new Set(ranked.map((candidate) => candidate.owner)).size, ranked.length);
  assert.deepEqual(ranked.slice(0, 4).map((candidate) => candidate.owner), [...causal].sort((a, b) => a.adaptive_rank - b.adaptive_rank).slice(0, 4).map((candidate) => candidate.owner));
  assert.ok(ranked.some((candidate) => candidate.owner === "src/runtime/compose.ts::composeHandler"));
});
