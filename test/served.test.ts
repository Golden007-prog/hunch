/**
 * Delivery receipts (dec_925f4bcaad): the machine-local served ledger.
 * Observed telemetry, own database under .hunch-cache/ — never the reindexed
 * store — and never throwing: a lost receipt must never cost a delivery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordServed, servedSummary } from "../src/core/served.js";

test("served ledger: receipts accrue, aggregate per record, and split serve from refresh", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-served-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  recordServed(root, [
    { event: "served", kind: "constraints", record_id: "con_a", target: "src/a.ts", session_id: "s1" },
    { event: "served", kind: "decisions", record_id: "dec_b", target: "src/a.ts", session_id: "s1" },
  ]);
  recordServed(root, [
    { event: "refreshed", kind: "constraints", record_id: "con_a", target: "src/a.ts", session_id: "s2" },
  ]);

  const summary = servedSummary(root);
  assert.equal(summary.total, 3);
  assert.equal(summary.distinct_records, 2);
  assert.equal(summary.distinct_sessions, 2);
  const conA = summary.rows.find((r) => r.record_id === "con_a");
  assert.deepEqual([conA?.serves, conA?.refreshes], [1, 1], "serve and refresh counted separately");
  assert.equal(summary.rows[0]?.record_id, "con_a", "ordered by serves+refreshes");
});

test("served ledger: empty input is a no-op and an unwritable root reads as empty, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-served-empty-"));
  recordServed(root, []);
  assert.equal(servedSummary(root).total, 0);
  rmSync(root, { recursive: true, force: true });

  // A root that cannot exist: recording and reading must both swallow, not throw.
  const impossible = join(root, "gone", "\0bad");
  recordServed(impossible, [{ event: "served", kind: "decisions", record_id: "dec_x", target: "src/x.ts" }]);
  assert.equal(servedSummary(impossible).total, 0, "unreadable ledger reads as empty");
});
