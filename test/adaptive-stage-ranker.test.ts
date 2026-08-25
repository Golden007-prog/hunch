import assert from "node:assert/strict";
import { test } from "node:test";
import { rankIssueAdaptiveCorrectionCandidates } from "../bench/external/adaptive-stage-ranker.js";
import { rankIssueAdaptiveCorrectionCandidates as rankProductCandidates } from "../src/core/correctionStage.js";

test("adaptive ranker follows repository-native path vocabulary instead of fixed filenames", () => {
  const sources = [
    { path: "src/value/parse/parse.ts", content: "export function Parse(value: unknown) { return value; }\n" },
    { path: "src/system/memory/update.ts", content: "export function Update(value: object) { return Object.freeze(value); }\n" },
  ];
  const ranked = rankIssueAdaptiveCorrectionCandidates("Memory.Update returns a mutable object when immutable types are enabled", sources);
  assert.equal(ranked[0]?.owner, "src/system/memory/update.ts::Update");
  assert.ok((ranked[0]?.path_overlap ?? 0) > 0);
});

test("adaptive ranker penalizes an invoked facade when a repository-native owner has stronger vocabulary", () => {
  const sources = [
    { path: "src/schema/parse.ts", content: "export function parse(value: unknown) { return validateContains(value); }\n" },
    { path: "src/schema/engine/contains.ts", content: "export function validateContains(value: unknown) { return value; }\n" },
  ];
  const ranked = rankIssueAdaptiveCorrectionCandidates("parse(value) incorrectly validates contains constraints", sources);
  assert.equal(ranked[0]?.owner, "src/schema/engine/contains.ts::validateContains");
  assert.ok(!ranked.some((candidate) => candidate.owner.endsWith("::parse")));
});

test("product adaptive ranking stays in parity with the frozen experimental implementation", () => {
  const sources = [
    { path: "src/schema/parse.ts", content: "export function parse(value: unknown) { return validateContains(value); }\n" },
    { path: "src/schema/engine/contains.ts", content: "export function validateContains(value: unknown) { return value; }\n" },
    { path: "src/system/memory/update.ts", content: "export interface UpdateOptions { freeze: boolean }\nexport function updateMemory(value: object) { return value; }\n" },
  ];
  const issue = "parse(value) incorrectly validates contains constraints while updating memory";
  assert.deepEqual(rankProductCandidates(issue, sources), rankIssueAdaptiveCorrectionCandidates(issue, sources));
});
