/**
 * A clean merge must never silently revert a bug closure (round-3 audit #8).
 *
 * Closing a bug does not touch `provenance` or `date` — captureTestRun writes
 * `{ ...bug, status: "fixed", lineage: { ...lineage, fixed_commit: sha } }` — so
 * `recency()` TIES against the still-open side and pickWinner always fell through to its
 * lexicographic tiebreak. That tiebreak preferred the LESS-resolved record twice over:
 * `"fixed_commit":null` sorts above `"fixed_commit":"<sha>"` (n > "), and `"status":"open"`
 * sorts above `"status":"fixed"` (o > f). Both differences point the same way, so the
 * closure lost deterministically — every time, with no conflict reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinner, mergeRecordsById, canon } from "../src/store/merge.js";

const AT = "2026-08-01T00:00:00.000Z";
const BUG = (over: Record<string, unknown> = {}) => ({
  id: "bug_checkout",
  title: "checkout drops the session",
  symptom: "500 on POST /checkout",
  root_cause: "session not threaded",
  severity: "high",
  status: "open",
  affected_files: ["src/pay.ts"],
  affected_symbols: [],
  lineage: {
    introduced_commit: null, detected: "payments integration", fixed_commit: null,
    recurrence_of: null, spawned_decision: null, spawned_constraint: null,
  },
  provenance: { source: "test_failure", confidence: 0.6, evidence: [] },
  date: AT,
  ...over,
});

/** Exactly what captureTestRun writes when the test starts passing again. */
const closed = (open: ReturnType<typeof BUG>) => ({
  ...open,
  status: "fixed",
  lineage: { ...open.lineage, fixed_commit: "abc1234" },
});

test("a closed bug beats the still-open side, whichever way the merge runs (#8)", () => {
  const open = BUG();
  const fixed = closed(open);

  // Precondition: this really does reach the tiebreak — the closure changes neither
  // provenance nor date, so the earlier tiers cannot separate the two sides.
  assert.equal(open.provenance.confidence, fixed.provenance.confidence, "confidence ties");
  assert.equal(open.date, fixed.date, "recency ties");

  assert.equal(pickWinner(fixed, open).status, "fixed", "ours=fixed wins");
  assert.equal(pickWinner(open, fixed).status, "fixed", "theirs=fixed wins — order must not matter");
});

test("the old lexicographic tiebreak would have picked the open side (#8)", () => {
  // Pins the exact mechanism, so a future refactor that reintroduces a bare
  // canon() comparison fails here with an explanation rather than silently.
  const open = BUG();
  const fixed = closed(open);
  assert.ok(canon(open) >= canon(fixed), "canon(open) sorts first — the old rule returned it");
});

test("a merge of a closure against an untouched open bug keeps the closure (#8)", () => {
  const base = BUG();
  const fixed = closed(base);
  // Both sides edited: theirs re-worded the symptom, ours closed it.
  const reworded = BUG({ symptom: "HTTP 500 on POST /checkout" });
  const merged = mergeRecordsById([base], [fixed], [reworded]); // (base, ours, theirs)
  assert.equal(merged.length, 1);
  assert.equal((merged[0] as { status: string }).status, "fixed", "the closure survives a real two-sided merge");
  assert.equal((merged[0] as { lineage: { fixed_commit: string } }).lineage.fixed_commit, "abc1234");
});

test("a genuine REOPEN still wins — evidence is ranked, not status (#8)", () => {
  // Reopening clears the commit, so the reopened record carries LESS closure evidence.
  // It must still be able to win on the tiers that come first: a human-confirmed or
  // more recent reopen must not be overridden by this new rule.
  const open = BUG();
  const fixed = closed(open);
  const reopened = {
    ...fixed,
    status: "open",
    lineage: { ...fixed.lineage, fixed_commit: null },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  };
  assert.equal(
    (pickWinner(reopened, fixed) as { status: string }).status,
    "open",
    "a human-confirmed reopen beats an auto-captured closure (human tier runs first)",
  );
});

test("other one-way lifecycle facts are preserved too (#8)", () => {
  // A supersession and an end-of-validity are equally one-way; a merge must not drop them.
  const live = { id: "dec_x", title: "t", status: "accepted", superseded_by: null, valid_to: null, provenance: { source: "extracted", confidence: 0.5, evidence: [] }, date: AT };
  const superseded = { ...live, status: "superseded", superseded_by: "dec_y" };
  assert.equal((pickWinner(superseded, live) as { superseded_by: string }).superseded_by, "dec_y");
  assert.equal((pickWinner(live, superseded) as { superseded_by: string }).superseded_by, "dec_y", "order-independent");

  const retired = { ...live, status: "retired", valid_to: AT };
  assert.equal((pickWinner(live, retired) as { valid_to: string }).valid_to, AT, "a retirement is not dropped");
});
