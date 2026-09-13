/** Actual HTTPS proxy + Chromium qualification of key-bound operator login. Isolated fixtures only. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpsServer } from 'node:https';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServeApp } from '../dist/serve/app.js';
import { initServeConfig, readServeConfig } from '../dist/serve/config.js';
const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'hunch-proof-browser-'));
let browser, app, proxy;
try {
  const cert = join(dir, 'cert.pem'), tlsKey = join(dir, 'tls.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  let backendPort;
  const requests = [];
  proxy = httpsServer({ key: readFileSync(tlsKey), cert: readFileSync(cert) }, (req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    const upstream = request({ hostname: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const origin = 'https://127.0.0.1:' + proxy.address().port;
  const keys = generateKeyPairSync('ed25519'), jwk = keys.privateKey.export({ format: 'jwk' });
  const file = join(dir, 'serve.json'), scope = { kind: 'organization', id: 'browser' };
  const { token } = initServeConfig({ file, scope, root: join(dir, 'workspace'), publicOrigin: origin, principal: { id: 'browser-reviewer', kind: 'human', proofKey: keys.publicKey.export({ format: 'jwk' }) } });
  app = createServeApp(readServeConfig(file)); await new Promise(r => app.listen(0, '127.0.0.1', r)); backendPort = app.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/operator');
  await page.getByLabel('Access token').fill(token);
  await page.getByText('Key-bound token', { exact: true }).click();
  await page.getByLabel('Private key file (Ed25519 JWK)').setInputFiles({ name: 'temporary-key.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(jwk)) });
  await page.screenshot({ path: join(tmpdir(), 'hunch-key-bound-connect.png'), fullPage: true });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace:not([hidden])').waitFor();
  assert.match(await page.locator('#identity').innerText(), /browser-reviewer/);
  await page.getByLabel('Find a subject or record').fill('test:subject');
  await page.getByRole('button', { name: 'Show state', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.ok(requests.some(r => r.headers.authorization?.startsWith('DPoP ') && r.headers.dpop));
  assert.ok(!JSON.stringify(requests).includes(jwk.d), 'private signing material never crosses the network');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(tmpdir(), 'hunch-key-bound-operator.png'), fullPage: true });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.equal(await page.locator('#proof-key').inputValue(), '');
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.deepEqual(errors, []);
  // Exercise the built CLI through the same actual TLS proxy and a trusted fixture CA.
  const privateFile = join(dir, 'private.pem'); writeFileSync(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const cli = spawn(process.execPath, [resolve('dist/cli/index.js'), 'state', '--url', origin, '--proof-key-file', privateFile, 'capabilities'], { env: { ...process.env, HUNCH_STATE_TOKEN: token, NODE_EXTRA_CA_CERTS: cert } });
  let stdout = '', stderr = ''; cli.stdout.on('data', d => { stdout += d; }); cli.stderr.on('data', d => { stderr += d; });
  const code = await new Promise((accept, reject) => { cli.once('error', reject); cli.once('close', accept); });
  assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).principal.id, 'browser-reviewer');
  assert.ok(!stdout.includes(token));
  console.log('PASS: actual HTTPS, browser-local Ed25519 proof, nonce challenge, scoped read, no private-key transmission/storage, disconnect, mobile layout, built CLI with fixture CA.');
} finally {
  await browser?.close();
  if (proxy) await new Promise(r => proxy.close(r));
  if (app) { await new Promise(r => app.close(r)); app.closeStores(); }
  rmSync(dir, { recursive: true, force: true });
}
