import assert from "node:assert/strict";
import test from "node:test";
import { collectStackOwnerEvidence, collectV8OwnerEvidence, collectV8RangeEvidence, conditionOwnersOnContrastiveV8Evidence, conditionOwnersOnRuntimeEvidence, conditionOwnersOnV8Evidence, inferIssueCorrectionStage, originalPositionFor, rankCausalBoundaryCandidates, rankIssueCorrectionStageCandidates } from "../bench/external/v8-owner-evidence.js";

test("source-map VLQ lookup carries original positions across generated lines", () => {
  assert.deepEqual(originalPositionFor("AAAA;AACA", 0, 0), { source: 0, line: 0, column: 0 });
  assert.deepEqual(originalPositionFor("AAAA;AACA", 1, 0), { source: 0, line: 1, column: 0 });
});

test("V8 coverage maps an executed generated range to its enclosing TS declaration", () => {
  const source = "export function alpha() {\n  return 1;\n}\nexport const beta = () => 2;\n";
  const url = "file:///tmp/repo/packages/lib/src/sample.ts";
  const result = collectV8OwnerEvidence({
    result: [{ url, functions: [{ functionName: "alpha", ranges: [{ startOffset: 0, endOffset: 5, count: 2 }] }] }],
    "source-map-cache": {
      [url]: {
        url,
        lineLengths: [10],
        data: { version: 3, sources: [url], sourcesContent: [source], mappings: "AAAA" },
      },
    },
  });
  assert.deepEqual(result.map(({ owner, count, original_line }) => ({ owner, count, original_line })), [{
    owner: "packages/lib/src/sample.ts::alpha",
    count: 2,
    original_line: 1,
  }]);
});

test("evidence conditioning excludes lexically plausible declarations that the red probe did not execute", () => {
  const url = "file:///tmp/repo/packages/lib/src/sample.ts";
  const sources = [{
    path: "packages/lib/src/sample.ts",
    content: "export function publicFacade() { return 1; }\nexport function internalOwner() { return 2; }\n",
  }];
  const coverage = {
    result: [{ url, functions: [{ functionName: "internalOwner", ranges: [{ startOffset: 0, endOffset: 5, count: 3 }] }] }],
    "source-map-cache": {
      [url]: {
        url,
        lineLengths: [10],
        data: { version: 3, sources: [url], sourcesContent: [sources[0]!.content], mappings: "AACA" },
      },
    },
  };
  const ranked = conditionOwnersOnV8Evidence("publicFacade fails; internalOwner owns the correction", sources, [coverage]);
  assert.deepEqual(ranked.map((candidate) => candidate.owner), ["packages/lib/src/sample.ts::internalOwner"]);
});

test("contrastive conditioning rewards target-only execution over a shared downstream path", () => {
  const targetUrl = "file:///tmp/repo/packages/lib/src/target.ts";
  const sharedUrl = "file:///tmp/repo/packages/lib/src/shared.ts";
  const targetSource = "export function targetOwner() { return 1; }\n";
  const sharedSource = "export function sharedParser() { return 2; }\n";
  const coverage = (includeTarget: boolean) => ({
    result: [
      ...(includeTarget ? [{ url: targetUrl, functions: [{ functionName: "targetOwner", ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] }] }] : []),
      { url: sharedUrl, functions: [{ functionName: "sharedParser", ranges: [{ startOffset: 0, endOffset: 4, count: 2 }] }] },
    ],
    "source-map-cache": {
      [targetUrl]: { url: targetUrl, lineLengths: [10], data: { version: 3, sources: [targetUrl], sourcesContent: [targetSource], mappings: "AAAA" } },
      [sharedUrl]: { url: sharedUrl, lineLengths: [10], data: { version: 3, sources: [sharedUrl], sourcesContent: [sharedSource], mappings: "AAAA" } },
    },
  });
  const sources = [
    { path: "packages/lib/src/target.ts", content: targetSource },
    { path: "packages/lib/src/shared.ts", content: sharedSource },
  ];
  const ranked = conditionOwnersOnContrastiveV8Evidence("targetOwner and sharedParser", sources, [coverage(true)], [coverage(false)]);
  assert.equal(ranked[0]?.owner, "packages/lib/src/target.ts::targetOwner");
});

test("stack evidence maps a source-mapped frame to its enclosing declaration", () => {
  const sources = [{
    path: "packages/lib/src/owner.ts",
    content: "export function outer() {\n  throw new Error('x');\n}\n",
  }];
  assert.deepEqual(collectStackOwnerEvidence("Error: x\n    at outer (/tmp/run/packages/lib/src/owner.ts:2:9)", sources), [
    "packages/lib/src/owner.ts::outer",
  ]);
});

test("runtime conditioning gives the first repository stack frame precedence over callers", () => {
  const url = "file:///tmp/repo/packages/lib/src/owners.ts";
  const content = "export function directOwner() { throw new Error('x'); }\nexport function publicCaller() { return directOwner(); }\n";
  const sources = [{ path: "packages/lib/src/owners.ts", content }];
  const coverage = {
    result: [{
      url,
      functions: [
        { functionName: "directOwner", ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] },
        { functionName: "publicCaller", ranges: [{ startOffset: 5, endOffset: 9, count: 1 }] },
      ],
    }],
    "source-map-cache": {
      [url]: { url, lineLengths: [4, 4], data: { version: 3, sources: [url], sourcesContent: [content], mappings: "AAAA;AACA" } },
    },
  };
  const ranked = conditionOwnersOnRuntimeEvidence(
    "publicCaller fails through directOwner",
    sources,
    [coverage],
    [],
    "Error: x\n    at directOwner (/tmp/repo/packages/lib/src/owners.ts:1:40)\n    at publicCaller (/tmp/repo/packages/lib/src/owners.ts:2:41)",
  );
  assert.equal(ranked[0]?.owner, "packages/lib/src/owners.ts::directOwner");
  assert.equal(ranked[0]?.stack_rank, 1);
});

test("causal boundary ranking prefers a target-only nested branch over a target-only function entry", () => {
  const url = "file:///tmp/repo/packages/lib/src/boundaries.ts";
  const content = "export function branchOwner() {\n  return 1;\n}\nexport function entryOnly() { return 2; }\n";
  const sources = [{ path: "packages/lib/src/boundaries.ts", content }];
  const coverage = (target: boolean) => ({
    result: [{
      url,
      functions: [
        { functionName: "branchOwner", ranges: [
          { startOffset: 0, endOffset: 9, count: 1 },
          ...(target ? [{ startOffset: 5, endOffset: 9, count: 1 }] : []),
        ] },
        ...(target ? [{ functionName: "entryOnly", ranges: [{ startOffset: 10, endOffset: 14, count: 1 }] }] : []),
      ],
    }],
    "source-map-cache": {
      [url]: { url, lineLengths: [4, 4, 4], data: { version: 3, sources: [url], sourcesContent: [content], mappings: "AAAA;AACA;AAEA" } },
    },
  });
  const ranges = collectV8RangeEvidence(coverage(true));
  assert.ok(ranges.some((item) => item.owner.endsWith("::branchOwner") && !item.function_root && item.original_line === 2));
  const ranked = rankCausalBoundaryCandidates("entryOnly branchOwner", sources, [coverage(true)], [coverage(false)]);
  assert.equal(ranked[0]?.owner, "packages/lib/src/boundaries.ts::branchOwner");
  assert.equal(ranked[0]?.evidence_tier, "target-only-branch");
  assert.deepEqual(ranked[0]?.target_only_branch_lines, [2]);
});

test("correction-stage routing separates a named public symptom API from its rendering owner", () => {
  const sources = [
    { path: "packages/lib/src/schemas.ts", content: "export function length() { return 1; }\n" },
    { path: "packages/lib/src/locales/en.ts", content: "export function error(issue: unknown) { return 'exact wording'; }\n" },
  ];
  const issue = ".length() error message ignores the exact flag and uses range wording";
  assert.equal(inferIssueCorrectionStage(issue), "presentation");
  assert.equal(rankIssueCorrectionStageCandidates(issue, sources)[0]?.owner, "packages/lib/src/locales/en.ts::error");
});

test("correction-stage routing excludes an invoked JSON facade when a deeper emission boundary exists", () => {
  const sources = [{
    path: "packages/lib/src/to-json-schema.ts",
    content: "export function toJSONSchema() { return extractDefs(); }\nexport function extractDefs() { return '$defs'; }\n",
  }];
  const ranked = rankIssueCorrectionStageCandidates("toJSONSchema() emits an invalid $ref into $defs", sources);
  assert.equal(ranked[0]?.owner, "packages/lib/src/to-json-schema.ts::extractDefs");
});
