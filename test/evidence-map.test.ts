import assert from "node:assert/strict";
import test from "node:test";
import { compileVerifiedEvidenceMap, formatVerifiedEvidenceMap } from "../src/core/evidenceMap.js";

test("verified evidence map separates execution, intervention sensitivity, and ownership", () => {
  const map = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A transformed wrapper must preserve the caller's issue.",
    probe: { target_before: "red", control_before: "green", target_after: "green", control_after: "green" },
    execution: [
      { owner: "src/wrapper.ts::runWrapper", target_count: 3, control_count: 0 },
      { owner: "src/parser.ts::parse", target_count: 8, control_count: 5 },
      { owner: "src/wrapper.ts::runWrapper", target_count: 2, control_count: 0 },
    ],
    interventions: [
      { owner: "src/wrapper.ts::runWrapper", mutation_id: "m1", target_after: "green", control_after: "green" },
      { owner: "src/parser.ts::parse", mutation_id: "m2", target_after: "green", control_after: "red" },
    ],
  });

  assert.equal(map.level, "behavior-sensitive");
  assert.equal(map.verification.authenticated, true);
  assert.equal(map.closure.status, "closed");
  assert.deepEqual(map.execution_slice.target_only_owners, ["src/wrapper.ts::runWrapper"]);
  assert.deepEqual(map.execution_slice.shared_owners, ["src/parser.ts::parse"]);
  assert.deepEqual(map.execution_slice.strong_differential_owners, ["src/wrapper.ts::runWrapper"]);
  assert.deepEqual(map.execution_slice.strong_differential_files, ["src/wrapper.ts"]);
  assert.deepEqual(map.intervention_slice, {
    admitted_receipts: 1,
    behavior_sensitive_owners: ["src/wrapper.ts::runWrapper"],
    behavior_sensitive_files: ["src/wrapper.ts"],
  });
  assert.deepEqual(map.files.map((file) => file.path), ["src/parser.ts", "src/wrapper.ts"]);
  assert.deepEqual(map.owner_claim, {
    enabled: false,
    owner: null,
    reason: "Execution and successful interventions establish behavioral influence, not correction ownership.",
  });
  assert.match(formatVerifiedEvidenceMap(map), /Exact-owner claim: disabled/);
  assert.match(formatVerifiedEvidenceMap(map), /did not run code or mutate/);
});

test("evidence map refuses to authenticate a red control and reports a control regression", () => {
  const unverified = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A claimed invariant",
    probe: { target_before: "red", control_before: "red", target_after: "green" },
    interventions: [{ owner: "src/run.ts::run", target_after: "green", control_after: "green" }],
  });
  assert.equal(unverified.level, "unverified");
  assert.equal(unverified.verification.authenticated, false);
  assert.equal(unverified.closure.status, "unverified");
  assert.deepEqual(unverified.intervention_slice.behavior_sensitive_owners, []);

  const unchecked = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A claimed invariant",
    probe: { target_before: "red", control_before: "green", target_after: "green" },
  });
  assert.equal(unchecked.closure.status, "control-unchecked");

  const regressed = compileVerifiedEvidenceMap({
    version: 1,
    claim: "A claimed invariant",
    probe: { target_before: "red", control_before: "green", target_after: "green", control_after: "red" },
  });
  assert.equal(regressed.closure.status, "control-regressed");
});

test("evidence map rejects unsafe or unbounded owner receipts", () => {
  assert.throws(() => compileVerifiedEvidenceMap({
    version: 1,
    claim: "unsafe owner",
    probe: { target_before: "red", control_before: "green" },
    execution: [{ owner: "../outside.ts::run", target_count: 1, control_count: 0 }],
  }), /safe repo-relative path/);
  assert.throws(() => compileVerifiedEvidenceMap({
    version: 1,
    claim: "negative count",
    probe: { target_before: "red", control_before: "green" },
    execution: [{ owner: "src/run.ts::run", target_count: -1, control_count: 0 }],
  }), /invalid verified-evidence receipt/);
});
