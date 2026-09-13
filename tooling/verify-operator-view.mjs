/** Real-browser qualification, isolated from user data.
 * npm run build
 * node tooling/verify-operator-view.mjs [path-to-playwright-module]
 * Requires Playwright and its Chromium browser in the verification environment.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServeApp } from '../dist/serve/app.js';
import { initServeConfig, readServeConfig } from '../dist/serve/config.js';
import { HunchStore } from '../dist/store/hunchStore.js';
import { hunchPaths } from '../dist/core/paths.js';
import { writeState } from '../dist/store/stateBinding.js';
import { captureBatchState } from '../dist/store/stateCapture.js';
import { stateHash } from '../dist/core/stateContract.js';
import { compactLedger } from '../dist/store/changeLedger.js';

const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'hunch-operator-'));
let browser, app, store;
try {
const file = join(dir, 'serve.json'), org = { kind: 'organization', id: 'demo' }, other = { kind: 'user', id: 'empty' };
initServeConfig({ file, scope: org, root: join(dir, 'org') });
const { token } = initServeConfig({ file, scope: other, root: join(dir, 'other'), principal: { id: 'reviewer', kind: 'human', grants: [org, other] } });
store = new HunchStore(hunchPaths(join(dir, 'org')));
const principal = { id: 'agent@demo', kind: 'agent', grants: [org] };
const provenance = { source: 'agent_recorded', confidence: 0.8, evidence: ['Demo source, not production data'] };
const ref = { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-13T10:00:00Z', locator: 'javascript:window.injected=true' };
const write = (facet, record, key) => writeState(store, { schema: 'nuryel.state.write/1', principal, scope: org, facet, record, idempotency_key: 'operator-' + key });
write('decisions', { id: 'dec_operator_demo', title: 'Keep customer follow-ups in one shared record', topic: 'event:42', status: 'accepted', context: 'Several agents follow the same customer.', decision: 'Check the shared record before starting a follow-up.', consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance, date: '2026-09-13T10:00:00Z' }, 'decision');
const title = 'Confirm the next visit <img src=x onerror="window.injected=true"> ' + 'חשוב '.repeat(40);
write('commitments', { schema: 'nuryel.commitment/1', scope: org, subject: 'event:42', title, owner: 'sofia', due: '2026-09-20', status: 'open', valid_from: '2026-09-13T10:00:00Z', valid_to: null, source: ref, provenance }, 'commitment');
const receipt = state => ({ schema: 'nuryel.receipt/1', scope: org, actor: 'sofia', action_kind: 'add_comment', target: ref, request_fingerprint: stateHash(state), state, occurred_at: '2026-09-13T10:01:00Z', invalidates: ['event:42'], provenance });
write('receipts', receipt('verified'), 'verified');
const failed = write('receipts', receipt('failed'), 'failed');
const addObservations = (start, count) => captureBatchState(store, {
  schema: 'nuryel.state.capture-batch/1', principal, scope: org,
  sources: [{ ref, source_text: Array.from({ length: count }, (_, i) => 'Customer observation ' + (start + i) + '.').join(' ') }],
  observations: Array.from({ length: count }, (_, i) => ({ subject: 'event:42', statement: 'Customer observation ' + (start + i) + '.', relevance: { use: 'operational_fact', reason: 'Prepare the next customer visit.' }, evidence: [{ source: 0, excerpt: 'Customer observation ' + (start + i) + '.' }] })),
});
for (let i = 0; i < 65; i += 32) addObservations(i, Math.min(32, 65 - i));
compactLedger(join(dir, 'org', '.hunch'), org, { keep: 20 });
app = createServeApp(readServeConfig(file), { openStore: root => root === join(dir, 'org') ? store : new HunchStore(hunchPaths(root)) });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], routes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { routes.push(new URL(r.url()).pathname); assert.ok(!r.url().includes(token)); });
  const idle = () => page.waitForFunction(() => !document.getElementById('refresh').disabled);
  const lookup = async value => { await page.locator('#subject').fill(value); await page.getByRole('button', { name: 'Show state', exact: true }).click(); await idle(); };
  await page.goto(base + '/operator');
  await page.locator('#token').fill('wrong'); await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'not accepted' }).waitFor();
  await page.locator('#token').fill(token); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await idle();
  assert.match(await page.locator('#activity-note').innerText(), /compacted/);
  assert.equal(await page.locator('#scope option').count(), 2);
  await page.screenshot({ path: join(tmpdir(), 'hunch-operator-activity.png') });
  await lookup('event:42');
  await page.getByRole('heading', { name: 'Current records (1)', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Open commitments & rules (1)', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Completed work (1)', exact: true }).waitFor();
  assert.match(await page.locator('#state-content').innerText(), /Observations 1–64 of 65/);
  assert.equal(await page.locator('#state-content img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator('#state-content .record-title').filter({ hasText: 'Customer observation' }).count(), 64);
  assert.ok(!(await page.locator('#state-content .record-title').allTextContents()).some(x => x.includes('nuryel.observation-content')));
  await page.screenshot({ path: join(tmpdir(), 'hunch-operator-desktop.png') });
  await page.getByRole('button', { name: 'Next observations', exact: true }).click(); await idle();
  assert.match(await page.locator('#state-content').innerText(), /Observations 65–65 of 65/);
  await page.getByRole('button', { name: 'First observations', exact: true }).click(); await idle();
  addObservations(65, 1);
  await page.getByRole('button', { name: 'Next observations', exact: true }).click(); await idle();
  assert.match(await page.getByRole('alert').innerText(), /changed between pages/);
  await lookup('event:42');
  assert.match(await page.locator('#state-content').innerText(), /of 66/);
  await page.locator('#subject').fill(failed.record_id); await page.locator('#inspect-id').click(); await idle();
  assert.match(await page.locator('#record-content').innerText(), /failed · receipts/);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await idle();
  assert.equal(await page.locator('#record-view').isVisible(), false);
  await page.locator('#subject').fill('missing-record'); await page.locator('#inspect-id').click(); await idle();
  assert.match(await page.locator('#record-content').innerText(), /no longer available/);
  await lookup('nothing-here'); assert.equal(await page.locator('#state-content .empty').count(), 3);

  // Hold an old workspace read until after a switch; its result must never reappear.
  let release, entered;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  await page.route('**/nuryel/v1/read', async route => { entered(); await held; await route.continue().catch(() => {}); });
  await page.locator('#subject').fill('event:42'); await page.getByRole('button', { name: 'Show state', exact: true }).click(); await started;
  assert.match(await page.locator('#status').innerText(), /Reading/);
  await page.locator('#scope').selectOption('1'); await idle(); release();
  await page.unroute('**/nuryel/v1/read');
  assert.equal(await page.locator('#state-content').innerText(), '');
  assert.match(await page.locator('#activity').innerText(), /No retained activity/);
  await page.locator('#scope').selectOption('0'); await idle();
  await page.route('**/nuryel/v1/read', route => route.abort('failed'));
  await lookup('event:42'); await page.getByRole('alert').waitFor();
  assert.match(await page.locator('#status').innerText(), /Update failed/);
  await page.unroute('**/nuryel/v1/read'); await lookup('event:42');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(tmpdir(), 'hunch-operator-mobile-' + colorScheme + '.png') });
  }
  await page.setViewportSize({ width: 720, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.locator('#subject').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Show state');
  assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage), document.cookie]), [[], [], '']);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#state-content').innerText(), '');
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.ok(routes.every(r => ['/operator', '/operator.js', '/operator.css', '/nuryel/v1/capabilities', '/nuryel/v1/read', '/nuryel/v1/records', '/nuryel/v1/subscribe'].includes(r)), JSON.stringify(routes));
  assert.deepEqual(errors, []);
  console.log('PASS: real HTTP + Chromium; auth, stored classifications, safe rendering, 66 observations + cursor conflict, record lookup, refresh, empty/error/loading, scope race, mobile/dark/zoom/keyboard, disconnect, read-only requests.');
  console.log('Screenshots: ' + join(tmpdir(), 'hunch-operator-*.png'));
} finally {
  await browser?.close(); if (app) { await new Promise(r => app.close(r)); app.closeStores(); } store?.close(); rmSync(dir, { recursive: true, force: true });
}
