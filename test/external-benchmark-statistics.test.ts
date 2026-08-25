import assert from "node:assert/strict";
import test from "node:test";
import { clusterBootstrapDifference, exactMcNemar, median, wilson } from "../bench/external/statistics.js";

test("external benchmark statistics match known small-sample values", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const interval = wilson(2, 4);
  assert.ok(Math.abs(interval.low - 0.1500) < 0.001);
  assert.ok(Math.abs(interval.high - 0.8500) < 0.001);
  assert.equal(exactMcNemar(0, 1), 1);
  assert.equal(exactMcNemar(0, 6), 0.03125);
});

test("cluster bootstrap keeps repeated runs nested inside tasks", () => {
  const interval = clusterBootstrapDifference([
    { task: "one", a: [0, 0], c: [1, 1] },
    { task: "two", a: [0, 0], c: [1, 1] },
  ], 1_000);
  assert.deepEqual(interval, { low: 1, high: 1 });
});
