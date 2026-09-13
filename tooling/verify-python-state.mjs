/** Real server / installed Python client round trip. Optional --proof adds actual TLS. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { createServeApp } from '../dist/serve/app.js';
import { initServeConfig, readServeConfig } from '../dist/serve/config.js';
import { stateHash, ReadResponseSchema, WriteResultSchema, RecordsResponseSchema, CaptureBatchResultSchema } from '../dist/core/stateContract.js';
import { HttpCapabilitiesSchema, HttpHealthSchema } from '../dist/core/stateHttp.js';
import { SubscribeResponseSchema } from '../dist/store/stateBinding.js';
import { assertDeliveryEnvelope } from '../dist/core/delivery.js';
const python = process.argv[2] ?? 'python3', proof = process.argv.includes('--proof');
const dir = mkdtempSync(join(tmpdir(), 'hunch-python-')), scope = { kind: 'organization', id: 'python' };
const file = join(dir, 'serve.json'), root = join(dir, 'partition');
let app, proxy;
try {
  const { token } = initServeConfig({ file, root, scope, principal: { id: 'writer', kind: 'agent' } });
  const { token: guest } = initServeConfig({ file, root, scope, principal: { id: 'guest', kind: 'agent' } });
  const content = 'Python summary: שלום 🌱';
  const provenance = { source: 'agent_recorded', confidence: 0.8, evidence: ['Python client fixture'] };
  const external = { system: 'fixture', object_type: 'document', object_key: 'python-source', version: 'v1', content_hash: stateHash('We use a shared state record.'), observed_at: '2026-09-13T10:00:00Z' };
  const fixture = { scope, write: { scope, facet: 'derived', idempotency_key: 'python-write-fixture', record: {
    schema: 'nuryel.derived/1', scope, subject: 'customer:python', content, content_hash: stateHash(content),
    dependencies: [{ kind: 'schema', name: 'fixture', fingerprint: stateHash('fixture') }],
    computed_at: '2026-09-13T10:00:00Z', transform_version: 'python/v1', valid_to: null, state: 'current', provenance,
    visibility: { owner: 'writer', readers: [], writers: [] },
  } }, capture: { scope, subject: 'team:python', statement: 'We use a shared state record.', relevance: { use: 'operational_fact', reason: 'Explains the team workflow' }, evidence: [{ ref: external, source_text: 'We use a shared state record.', excerpt: 'We use a shared state record.' }] } };
  fixture.batch = { scope, sources: [{ ref: external, source_text: 'We use a shared state record.' }], observations: [{ subject: 'team:batch', statement: 'We use a shared state record.', relevance: fixture.capture.relevance, evidence: [{ source: 0, excerpt: 'We use a shared state record.' }] }] };
  let boundToken, backendPort;
  if (proof) {
    const cert = join(dir, 'cert.pem'), tlsKey = join(dir, 'tls.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
    proxy = createServer({ key: readFileSync(tlsKey), cert: readFileSync(cert) }, (req, res) => {
      const upstream = request({ hostname: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    fixture.https_url = 'https://127.0.0.1:' + proxy.address().port; fixture.ca_file = cert;
    const keys = generateKeyPairSync('ed25519');
    fixture.private_pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
    fixture.private_jwk = JSON.stringify(keys.privateKey.export({ format: 'jwk' }));
    boundToken = initServeConfig({ file, root, scope, publicOrigin: fixture.https_url, principal: { id: 'bound', kind: 'agent', proofKey: keys.publicKey.export({ format: 'jwk' }) } }).token;
  }
  app = createServeApp(readServeConfig(file)); await new Promise(r => app.listen(0, '127.0.0.1', r)); backendPort = app.address().port;
  fixture.url = 'http://127.0.0.1:' + backendPort;
  const input = join(dir, 'fixture.json'); writeFileSync(input, JSON.stringify(fixture), { mode: 0o600 });
  const child = spawn(python, [resolve('clients/python/tests/roundtrip.py'), input], { env: { ...process.env, HUNCH_PYTHON_TEST_TOKEN: token, HUNCH_PYTHON_TEST_GUEST: guest, ...(boundToken ? { HUNCH_PYTHON_TEST_BOUND: boundToken } : {}) } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, stderr); const output = JSON.parse(stdout);
  HttpHealthSchema.parse(output.health); HttpCapabilitiesSchema.parse(output.capabilities);
  const { envelope, ...read } = output.read; ReadResponseSchema.parse(read); assertDeliveryEnvelope(envelope);
  WriteResultSchema.parse(output.write); WriteResultSchema.parse(output.capture); CaptureBatchResultSchema.parse(output.batch);
  RecordsResponseSchema.parse(output.records); SubscribeResponseSchema.parse(output.subscribe);
  assert.ok(!stdout.includes(token) && !stdout.includes(guest));
  console.log('PASS: installed Python client -> real server; canonical responses, Unicode, idempotency, scoped/record permissions, capture/batch, events and typed refusals' + (proof ? ', HTTPS DPoP PEM/JWK' : '') + '.');
} finally {
  if (proxy) await new Promise(r => proxy.close(r));
  if (app) { await new Promise(r => app.close(r)); app.closeStores(); }
  rmSync(dir, { recursive: true, force: true });
}
