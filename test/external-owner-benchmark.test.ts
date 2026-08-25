import assert from "node:assert/strict";
import test from "node:test";
import {
  changedLineNumbers,
  declarationOwners,
  deriveProbeCategory,
} from "../bench/external/evaluate-zod-owner-ranker.js";

test("owner benchmark classifies issue-only contract categories deterministically", () => {
  assert.equal(deriveProbeCategory("JSON Schema output", "z.toJSONSchema(value)"), "serialization");
  assert.equal(deriveProbeCategory("Compiler accepts bad input", "TypeScript should report a compile-time error"), "types");
  assert.equal(deriveProbeCategory("Public parity", "Classic succeeds while Mini fails"), "compatibility");
  assert.equal(deriveProbeCategory("Parser throws", "safeParse should return an issue"), "behavior");
});

test("owner benchmark parses zero-width and ordinary diff hunks", () => {
  const lines = changedLineNumbers([
    "@@ -10,2 +10,3 @@",
    "@@ -30,0 +32,2 @@",
    "@@ -50,4 +53,0 @@",
  ].join("\n"));
  assert.deepEqual([...lines.before], [10, 11, 50, 51, 52, 53]);
  assert.deepEqual([...lines.after], [10, 11, 12, 32, 33]);
});

test("owner benchmark labels changed lines by top-level declaration", () => {
  const source = [
    "export function alpha() {",
    "  const local = 1;",
    "  return local;",
    "}",
    "export const beta = () => {",
    "  return 2;",
    "};",
  ].join("\n");
  assert.deepEqual(declarationOwners("src/sample.ts", source), [
    { owner: "src/sample.ts::alpha", startLine: 1, endLine: 4 },
    { owner: "src/sample.ts::beta", startLine: 5, endLine: 7 },
  ]);
});
