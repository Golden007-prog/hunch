import { test } from "node:test";
import assert from "node:assert/strict";
import { isStrictBlocker, STRICT_MIN_CONFIDENCE } from "../src/core/strictgate.js";

// The hardened --strict gate: a commit may be FAILED only by a direct,
// high-confidence, non-stale BLOCKING invariant. Everything weaker is advisory.
// (The "near"/blast-radius case can't reach this gate at all — the CLI passes only
// directly-scoped invariants in; see check.test.ts "near-violation" for the proof
// that a blast-radius constraint has zero DIRECT hits.)

const c = (severity: string, confidence: number, source = "derived") => ({
  severity,
  provenance: { confidence, source },
});

test("strict BLOCKS on a direct, high-confidence, non-stale blocking invariant", () => {
  assert.equal(isStrictBlocker(c("blocking", 0.95), false), true);
});

test("strict does NOT block on a STALE blocking invariant (graph may be wrong)", () => {
  assert.equal(isStrictBlocker(c("blocking", 0.95), true), false);
});

test("strict does NOT block on a LOW-confidence blocking invariant (auto-derived guess)", () => {
  assert.equal(isStrictBlocker(c("blocking", 0.5), false), false);
});

test("strict BLOCKS on a human-confirmed invariant even at low numeric confidence", () => {
  assert.equal(isStrictBlocker(c("blocking", 0.4, "human_confirmed"), false), true);
});

test("strict NEVER blocks on a non-blocking severity", () => {
  assert.equal(isStrictBlocker(c("warning", 1), false), false);
  assert.equal(isStrictBlocker(c("advisory", 1), false), false);
});

test("confidence exactly at the threshold qualifies", () => {
  assert.equal(isStrictBlocker(c("blocking", STRICT_MIN_CONFIDENCE), false), true);
});

test("missing provenance does not block", () => {
  assert.equal(isStrictBlocker({ severity: "blocking" }, false), false);
});
