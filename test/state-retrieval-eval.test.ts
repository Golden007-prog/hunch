import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStateFixture } from '../bench/state-recall.js';

test('state recall fixture preserves known answers, identity, freshness and permissions', async () => {
  const report = await evaluateStateFixture();
  assert.equal(report.corpus.origin, 'synthetic-public-fixture');
  assert.equal(report.lexical.literal.n, 8);
  assert.equal(report.lexical.paraphrase.n, 4);
  assert.equal(report.lexical.literal.recallAtK, 1, JSON.stringify(report.lexical.literal.perCase));
  assert.ok(report.lexical.literal.mrr >= 0.75, JSON.stringify(report.lexical.literal));
  assert.deepEqual(report.invariants.failures, []);
  assert.equal(report.invariants.checks, 13);
  assert.equal(report.semantic.status, 'not-run');
});
