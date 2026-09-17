/**
 * `hunch serve` — the HTTP binding of nuryel.state/1 and the served partition host — driven
 * through the typed client. The rules are the store binding's; these tests assert the transport:
 * bearer → principal, grants before anything, problem+json refusals, the write lock, and that a
 * served partition declares its own scope so user/organization state needs no overlay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BODY_LIMIT_BYTES, createServeApp } from "../src/serve/app.js";
import { hashToken, initServeConfig, readServeConfig, resolvePrincipal } from "../src/serve/config.js";
import { withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { createStateClient, StateClientError } from "../src/client/state.js";
import { stateHash, assertChangeSequence } from "../src/core/stateContract.js";
import { partitionOf } from "../src/store/stateBinding.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const david = { kind: "user" as const, id: "david" };
const acme = { kind: "organization" as const, id: "acme" };
const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", observed_at: "2026-09-08T10:00:00Z" };

function served() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-"));
  const file = join(dir, "hunch-serve.json");
  const userInit = initServeConfig({ file, scope: david, root: join(dir, "david"), principal: { id: "sofia@david", kind: "agent" } });
  const orgInit = initServeConfig({ file, scope: acme, root: join(dir, "acme"), principal: { id: "orc", kind: "service", grants: [acme, david] } });
  const config = readServeConfig(file);
  const app = createServeApp(config, { version: "test" });
  const cleanup = async () => { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, config, app, sofiaToken: userInit.token!, orcToken: orgInit.token!, cleanup };
}

async function listen(app: ReturnType<typeof createServeApp>): Promise<string> {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const address = app.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

test("operator view serves a public shell with no partition data and keeps reads authenticated", async () => {
  const { app, sofiaToken, cleanup } = served();
  try {
    const base = await listen(app);
    const page = await fetch(`${base}/operator`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(page.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /Shared state/);
    for (const secret of [sofiaToken, "sofia@david", "organization/acme"]) assert.ok(!html.includes(secret));
    for (const [path, type] of [["operator.js", "text/javascript"], ["operator.css", "text/css"]]) {
      const asset = await fetch(`${base}/${path}`);
      assert.equal(asset.status, 200);
      assert.ok(asset.headers.get("content-type")?.startsWith(type!));
      assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    }
    const denied = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: david, subject: "customer:c1" }) });
    assert.equal(denied.status, 401);
    const foreign = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: JSON.stringify({ scope: acme, subject: "customer:c1" }) });
    assert.equal(foreign.status, 403);
  } finally { await cleanup(); }
});

test("serve init declares the partition, mints a token once, stores only its hash, and refuses grants the server does not serve", () => {
  const { dir, file, config, sofiaToken, cleanup } = served();
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "david", ".hunch", "partition.json"), "utf8")), david);
    assert.ok(existsSync(join(dir, "david", ".hunch", "manifest.json")));
    assert.match(readFileSync(join(dir, "david", ".gitignore"), "utf8"), /\.hunch\/\*\.sqlite/, "the partition ignores its derived index");
    assert.equal(config.partitions.length, 2);
    const sofia = config.principals.find((p) => p.id === "sofia@david")!;
    assert.equal(sofia.token_sha256, hashToken(sofiaToken));
    assert.ok(!readFileSync(file, "utf8").includes(sofiaToken), "the plaintext token is never written");
    assert.deepEqual(resolvePrincipal(config, sofiaToken)?.grants, [david]);
    assert.equal(resolvePrincipal(config, "nope"), undefined);
    assert.throws(() => initServeConfig({ file, scope: acme, root: join(dir, "david") }), /already declares partition user\/david/);
    const store = new HunchStore(hunchPaths(join(dir, "david")));
    try { assert.deepEqual(partitionOf(store), david, "the store knows the partition it IS"); } finally { store.close(); }
  } finally { void cleanup(); }
});

test("HTTP: bearer resolves the principal, grants gate every route, refusals are problem+json, and the typed client round-trips the three verbs", async () => {
  const { app, sofiaToken, orcToken, dir, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const nobody = createStateClient({ baseUrl: base, token: "nyt_wrong" });

    assert.equal((await sofia.health()).protocol, "nuryel.state/1");
    await assert.rejects(nobody.capabilities(), (e: StateClientError) => e.status === 401 && e.code === "unauthorized");
    const caps = await sofia.capabilities();
    assert.deepEqual(caps.repository, david, "a served partition reports itself, not a directory name");
    assert.deepEqual(caps.principal.grants, [david]);

    // A user-partition write needs no overlay: the partition IS the store.
    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ c: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const created = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "sofia-approval-http-1" });
    assert.equal(created.outcome, "created");
    assert.match(created.record_id, /^nrc_[a-f0-9]{24}$/);
    assert.ok(existsSync(join(dir, "david", ".hunch", "receipts", `${created.record_id}.json`)), "landed in the served partition directory");
    assert.ok(existsSync(join(dir, "david", ".hunch", "changes")), "with its ledger beside it");
    assert.equal((await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "sofia-approval-http-1" })).outcome, "replayed");

    // The body may not name a principal; the token did. Grants are decided from the config.
    await assert.rejects(sofia.write({ scope: acme, facet: "receipts", record: receipt, idempotency_key: "sofia-into-org-1" }), (e: StateClientError) => {
      assert.equal(e.status, 403); assert.equal(e.code, "outside-grants"); return true;
    });
    const smuggled = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: JSON.stringify({ scope: acme, principal: { id: "orc", kind: "service", grants: [acme] } }) });
    assert.equal(smuggled.status, 403, "a principal in the body is ignored");

    // Typed refusals carry the binding's code and the incumbent.
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { ...receipt, state: "failed" }, idempotency_key: "sofia-approval-http-1" }), (e: StateClientError) => {
      assert.equal(e.status, 409); assert.equal(e.code, "idempotency"); assert.equal(e.problem.conflict?.incumbent_id, created.record_id); return true;
    });
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { ...receipt, id: "nrc_000000000000000000000000" }, idempotency_key: "sofia-approval-http-2" }), (e: StateClientError) => e.status === 422 && e.code === "identity");
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { provenance: prov }, idempotency_key: "sofia-approval-http-3" }), (e: StateClientError) => e.status === 400 && e.code === "malformed");

    // ORC holds both partitions: it reads Sofia's user state and writes organization state.
    const read = await orc.read({ scope: david, subject: "customer:c1" });
    assert.match(read.receipt_id, /^hdr_[a-f0-9]{24}$/);
    assert.deepEqual(read.state_of_record?.invalidated_by, [created.record_id]);
    assert.equal(read.envelope.receipt_id, read.receipt_id, "the envelope rides along over HTTP");
    const orgWrite = await orc.write({ scope: acme, facet: "commitments", record: { schema: "nuryel.commitment/1", scope: acme, subject: "customer:c1", title: "quarterly review", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov }, idempotency_key: "orc-commitment-1" });
    assert.equal(orgWrite.outcome, "created");
    assert.ok(existsSync(join(dir, "acme", ".hunch", "commitments", `${orgWrite.record_id}.json`)));
    await assert.rejects(sofia.subscribe({ scope: acme, after_seq: 0 }), (e: StateClientError) => e.status === 403);
    const byId = await orc.records({ scope: david, ids: [created.record_id, "nrc_000000000000000000000000"] });
    assert.equal((byId.records[created.record_id] as { state?: string })?.state, "verified", "records by id over HTTP");
    assert.deepEqual(byId.missing, ["nrc_000000000000000000000000"]);
    assert.equal((created as { record?: { state?: string } }).record?.state, "verified", "the write result carries the stored record over HTTP");
    const stream = await orc.subscribe({ scope: david, after_seq: 0 });
    assert.equal(stream.head_seq, 1);
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
    assert.deepEqual(stream.events[0]?.cause, { kind: "write", principal: "sofia@david" });

    const big = await fetch(`${base}/nuryel/v1/write`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: Buffer.alloc(BODY_LIMIT_BYTES + 1, 97) });
    assert.equal(big.status, 413, "an actually oversized body is rejected");
    const malformed = await fetch(`${base}/nuryel/v1/write`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: "[" });
    assert.equal(malformed.status, 400, "malformed JSON is a typed client error");
    assert.equal((await sofia.health()).ok, true, "the server remains usable after rejected bodies");
  } finally { await cleanup(); }
});

test("union read: `scopes` gives a principal granted several partitions ONE state_of_record; an ungranted extra is named in denied_scopes, not refused", async () => {
  const { app, sofiaToken, orcToken, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ u: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const done = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "union-receipt-1" });
    const open = await orc.write({ scope: acme, facet: "commitments", record: { schema: "nuryel.commitment/1", scope: acme, subject: "customer:c1", title: "quarterly review", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov }, idempotency_key: "union-commitment-1" });

    // ORC holds both drawers: one call, both partitions, every ref tagged with its own scope.
    const union = await orc.read({ scope: david, scopes: [david, acme], subject: "customer:c1" });
    assert.match(union.receipt_id, /^hdr_[a-f0-9]{24}$/);
    assert.deepEqual(union.scope, david, "the primary scope leads");
    assert.deepEqual(union.scopes, [david, acme]);
    assert.equal(union.receipts?.length, 2);
    assert.equal(union.receipts?.[0]?.receipt_id, union.receipt_id, "receipt_id stays the primary's");
    assert.deepEqual(union.receipts?.map((r) => r.scope), [david, acme]);
    assert.ok(union.receipts?.every((r) => /^hdr_[a-f0-9]{24}$/.test(r.receipt_id)));
    assert.deepEqual(union.denied_scopes, []);
    assert.deepEqual(union.state_of_record?.done.map((r) => [r.id, r.scope]), [[done.record_id, david]]);
    assert.deepEqual(union.state_of_record?.in_force.map((r) => [r.id, r.scope]), [[open.record_id, acme]]);
    assert.deepEqual(union.state_of_record?.invalidated_by, [done.record_id]);
    assert.deepEqual(Object.keys(union.records ?? {}).sort(), [done.record_id, open.record_id].sort(), "records from both partitions ride along");
    assert.equal(union.envelope.receipt_id, union.receipt_id, "the envelope is the primary's");

    // Sofia holds only user/david: the same request answers from david and NAMES acme — 200, not 403.
    const partial = await sofia.read({ scope: david, scopes: [david, acme], subject: "customer:c1" });
    assert.deepEqual(partial.scopes, [david]);
    assert.deepEqual(partial.denied_scopes, [acme]);
    assert.equal(partial.receipts?.length, 1);
    assert.deepEqual(partial.state_of_record?.done.map((r) => r.id), [done.record_id]);
    assert.deepEqual(partial.state_of_record?.in_force, []);
    assert.ok(!(open.record_id in (partial.records ?? {})), "nothing from the ungranted partition is described");

    // Without `scopes` nothing changes: a single-partition read carries neither `scopes` nor `receipts`.
    const single = await orc.read({ scope: acme, subject: "customer:c1" });
    assert.equal(single.scopes, undefined);
    assert.equal(single.receipts, undefined);
    assert.deepEqual(single.state_of_record?.in_force.map((r) => r.id), [open.record_id]);

    // The primary scope is still gated as before; a malformed `scopes` is a typed 400.
    await assert.rejects(sofia.read({ scope: acme, scopes: [david], subject: "customer:c1" }), (e: StateClientError) => e.status === 403 && e.code === "outside-grants");
    await assert.rejects(orc.read({ scope: david, scopes: [], subject: "customer:c1" }), (e: StateClientError) => e.status === 400 && e.code === "invalid-scope");
  } finally { await cleanup(); }
});

test("concurrent writes to one partition serialize under the write lock: the ledger stays contiguous", async () => {
  const { app, sofiaToken, dir, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sofia.write({
      scope: david, facet: "commitments",
      record: { schema: "nuryel.commitment/1", scope: david, subject: "customer:c1", title: `task ${i}`, owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov },
      idempotency_key: `parallel-commitment-${i}`,
    })));
    assert.deepEqual(results.map((r) => r.outcome), Array(6).fill("created"));
    const stream = await sofia.subscribe({ scope: david, after_seq: 0 });
    assert.equal(stream.head_seq, 6);
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
    assert.ok(!existsSync(writeLockPath(join(dir, "david", ".hunch"))), "the lock is released");
  } finally { await cleanup(); }
});

test("the write lock is held across a sync section and released on throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-"));
  try {
    let inside = 0, max = 0;
    const work = () => withWriteLock(dir, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 15)); inside--; });
    await Promise.all([work(), work(), work()]);
    assert.equal(max, 1, "never two holders");
    await assert.rejects(withWriteLock(dir, () => { throw new Error("boom"); }), /boom/);
    assert.ok(!existsSync(writeLockPath(dir)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the write lock never steals a stale-looking lock held by a live same-host process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-live-"));
  try {
    const path = writeLockPath(dir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "other", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(path, old, old);
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 25 }),
      /write lock .* held by pid/,
    );
    assert.equal(entered, false, "a live same-host owner must keep the lock despite its age");
    assert.ok(existsSync(path), "the live owner's lock remains intact");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP writes lock the shared overlay home, leaving a public lock owned by another writer intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-overlay-lock-"));
  const root = join(dir, "david");
  const overlayRoot = join(dir, "memory");
  const overlay = join(overlayRoot, ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", overlayRoot]);
  const file = join(dir, "hunch-serve.json");
  const init = initServeConfig({ file, scope: david, root, principal: { id: "sofia@david", kind: "agent" } });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared", autoCommit: false }) + "\n");
  const publicLock = writeLockPath(join(root, ".hunch"));
  try {
    // A live writer in the public checkout may be old enough to trip age-based
    // stealing. Shared-mode state belongs to the overlay, so this request must
    // leave that unrelated public lock untouched.
    writeFileSync(publicLock, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "public-writer", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(publicLock, old, old);
    const app = createServeApp(readServeConfig(file), { version: "test" });
    try {
      const base = await listen(app);
      const sofia = createStateClient({ baseUrl: base, token: init.token! });
      const result = await sofia.write({
        scope: david,
        facet: "commitments",
        record: { schema: "nuryel.commitment/1", scope: david, subject: "customer:overlay-lock", title: "overlay lock", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov },
        idempotency_key: "overlay-lock-http-1",
      });
      assert.equal(result.outcome, "created");
      assert.ok(existsSync(publicLock), "the public writer's lock was not stolen");
      assert.ok(existsSync(join(overlay, "commitments", `${result.record_id}.json`)), "the record landed in the shared overlay");
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
      app.closeStores();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: `hunch serve init --config <file>` honors the path from any cwd (1.26.0 handed it to the parent command)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-cli-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "hunch-serve-cli-cwd-"));
  try {
    const cli = join(process.cwd(), "src", "cli", "index.ts");
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const out = execFileSync(process.execPath, [tsx, cli, "serve", "init", "--config", join(dir, "cfg.json"), "--partition", "user:cli", "--root", join(dir, "cli"), "--principal", "p", "--port", "27780", "--json"], { cwd: elsewhere, encoding: "utf8", env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic" } });
    const parsed = JSON.parse(out.trim().split(/\r?\n/).at(-1)!) as { config: string; token: string | null };
    assert.equal(parsed.config, join(dir, "cfg.json"));
    assert.ok(existsSync(join(dir, "cfg.json")), "written where asked");
    assert.ok(!existsSync(join(elsewhere, "hunch-serve.json")), "and not into the cwd");
    assert.ok(parsed.token && !readFileSync(join(dir, "cfg.json"), "utf8").includes(parsed.token));
    assert.equal(readServeConfig(join(dir, "cfg.json")).port, 27780, "--port after init reaches init, not the parent");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("a served partition that is a git repository commits every write: durability is committed, not local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-durable-"));
  try {
    const file = join(dir, "hunch-serve.json");
    const root = join(dir, "david");
    const init = initServeConfig({ file, scope: david, root, principal: { id: "sofia@david", kind: "agent" } });
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "test"]);
    const app = createServeApp(readServeConfig(file), { version: "test" });
    try {
      const base = await listen(app);
      const sofia = createStateClient({ baseUrl: base, token: init.token! });
      const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ d: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: [] };
      const created = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "durable-1" });
      assert.equal(created.outcome, "created");
      assert.equal(created.durability, "committed", "the flush ran under the write lock and still committed");
      const log = execFileSync("git", ["-C", root, "log", "--format=%s", "--name-only"], { encoding: "utf8" });
      assert.match(log, /nuryel: write nrc_/);
      assert.match(log, /\.hunch\/receipts\/nrc_[a-f0-9]{24}\.json/, "the record is in the commit");
      assert.match(log, /\.hunch\/changes\/user-david-[a-f0-9]{8}\.json/, "the ledger rides the same commit");
      assert.match(log, /\.hunch\/partition\.json/, "the partition declaration is committed");
      assert.doesNotMatch(log, /write\.lock|hunch\.sqlite/, "derived artifacts never enter a commit");
      assert.ok(!existsSync(writeLockPath(join(root, ".hunch"))));
    } finally { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP and typed client round-trip field citations and refuse stale value bindings", async () => {
  const { app, sofiaToken, cleanup } = served();
  try {
    const client = createStateClient({ baseUrl: await listen(app), token: sofiaToken });
    const caps = await client.capabilities();
    assert.ok(caps.capabilities.includes("nuryel.field-provenance/1"));
    const dependency = { kind: "external", ref: crmEvent }, content = "😀 Ready.";
    const field_provenance = [{ selector: { kind: "text", start: 2, end: 8 }, value_hash: stateHash("Ready."), dependency_hashes: [stateHash(dependency)] }];
    const record = { schema: "nuryel.derived/1", scope: david, subject: "customer:cited", content, content_hash: stateHash(content), dependencies: [dependency], transform_version: "cited/v1", computed_at: "2026-09-13T10:00:00Z", valid_to: null, state: "current", provenance: prov, field_provenance };
    const written = await client.write({ scope: david, facet: "derived", record, idempotency_key: "cited-http-write" });
    assert.deepEqual(written.record?.field_provenance, field_provenance);
    const read = await client.read({ scope: david, subject: "customer:cited" });
    assert.deepEqual(read.records?.[written.record_id]?.field_provenance, field_provenance);
    const exact = await client.records({ scope: david, ids: [written.record_id] });
    assert.deepEqual(exact.records[written.record_id]?.field_provenance, field_provenance);
    await assert.rejects(client.write({ scope: david, facet: "derived", record: { ...record, field_provenance: [{ ...field_provenance[0], value_hash: stateHash("Changed") }] }, idempotency_key: "cited-http-invalid" }), (e: StateClientError) => e.status === 400 && e.code === "malformed" && /value_hash/.test(e.message));
  } finally { await cleanup(); }
});

test('HTTP authenticates visibility across partitions and concurrent users, including source revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-http-visibility-')), file = join(dir, 'serve.json');
  initServeConfig({ file, scope: david, root: join(dir, 'user') });
  const ownerToken = initServeConfig({ file, scope: acme, root: join(dir, 'org'), principal: { id: 'owner', kind: 'human', grants: [david, acme] } }).token!;
  const readerToken = initServeConfig({ file, scope: acme, root: join(dir, 'org'), principal: { id: 'reader', kind: 'agent', grants: [david, acme] } }).token!;
  const app = createServeApp(readServeConfig(file));
  try {
    const base = await listen(app), owner = createStateClient({ baseUrl: base, token: ownerToken }), reader = createStateClient({ baseUrl: base, token: readerToken });
    const visibility = { owner: 'owner', readers: ['reader'], writers: [] };
    const content = 'Restricted CRM schedule';
    const source = await owner.write({ scope: david, facet: 'derived', idempotency_key: 'cross-private-source', record: { schema: 'nuryel.derived/1', scope: david, subject: 'customer:restricted', content, content_hash: stateHash(content), dependencies: [{ kind: 'schema', name: 'crm', fingerprint: stateHash('v1') }], transform_version: 'schedule/v1', computed_at: '2026-09-13T10:00:00Z', valid_to: null, state: 'current', provenance: prov, visibility } });
    const linked = await owner.write({ scope: acme, facet: 'derived', idempotency_key: 'cross-linked-record', record: { ...source.record, id: undefined, visibility: undefined, scope: acme, transform_version: 'linked/v1', dependencies: [{ kind: 'record', scope: david, id: source.record_id, record_hash: source.record_hash }] } });
    assert.ok((await reader.records({ scope: acme, ids: [linked.record_id] })).records[linked.record_id]);
    await owner.write({ scope: david, facet: 'derived', idempotency_key: 'revoke-source-reader', expected_version: source.record_hash, record: { ...source.record, visibility: { ...visibility, readers: [] } } });
    const [own, denied] = await Promise.all([owner.read({ scope: acme, subject: 'customer:restricted' }), reader.read({ scope: acme, subject: 'customer:restricted' })]);
    assert.equal(own.state_of_record?.current.length, 1);
    assert.deepEqual(denied.state_of_record?.current, []);
    assert.ok(!JSON.stringify(denied).includes(source.record_id));
    assert.deepEqual((await reader.records({ scope: acme, ids: [linked.record_id] })).missing, [linked.record_id]);
    assert.deepEqual((await reader.subscribe({ scope: acme, after_seq: 0 })).events, []);
    const spoof = await fetch(base + '/nuryel/v1/records', { method: 'POST', headers: { authorization: 'Bearer ' + readerToken, 'content-type': 'application/json' }, body: JSON.stringify({ principal: { id: 'owner', kind: 'human', grants: [david, acme] }, scope: david, ids: [source.record_id] }) });
    assert.deepEqual((await spoof.json() as { missing: string[] }).missing, [source.record_id]);
    await assert.rejects(reader.write({ scope: david, facet: 'derived', idempotency_key: 'cross-private-source', record: source.record! }), (e: StateClientError) => e.status === 403 && !JSON.stringify(e.problem).includes(source.record_id));
  } finally { await new Promise<void>(r => app.close(() => r())); app.closeStores(); rmSync(dir, { recursive: true, force: true }); }
});

test("MCP over streamable HTTP: the nuryel_* tools behind the same credential, grants and refusals as the REST routes", async () => {
  const { app, sofiaToken, orcToken, cleanup } = served();
  try {
    const base = await listen(app);
    const connect = async (token: string) => {
      const client = new McpClient({ name: "serve-mcp-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/nuryel/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    // No credential → the same 401 problem as every other route; MCP is never a way around auth.
    const anon = new McpClient({ name: "anon", version: "1.0.0" });
    await assert.rejects(anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/nuryel/v1/mcp`))), /401/);
    // GET is refused: the server is stateless, there is no stream to open.
    const get = await fetch(`${base}/nuryel/v1/mcp`, { headers: { authorization: `Bearer ${sofiaToken}` } });
    assert.equal(get.status, 405);

    const sofia = await connect(sofiaToken);
    const tools = (await sofia.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["nuryel_capabilities", "nuryel_capture", "nuryel_capture_batch", "nuryel_read", "nuryel_records", "nuryel_subscribe", "nuryel_write"]);
    const caps = await sofia.callTool({ name: "nuryel_capabilities", arguments: {} });
    const capsOut = caps.structuredContent as { protocol: string; principal: { id: string; grants: unknown[] } };
    assert.equal(capsOut.protocol, "nuryel.state/1");
    assert.equal(capsOut.principal.id, "sofia@david");

    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ mcp: 1 }), state: "verified", occurred_at: "2026-09-16T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const write = async (client: InstanceType<typeof McpClient>, args: Record<string, unknown>) => client.callTool({ name: "nuryel_write", arguments: args });
    const created = await write(sofia, { scope: david, facet: "receipts", record: receipt, idempotency_key: "mcp-receipt-1" });
    assert.equal(created.isError, undefined);
    const createdOut = created.structuredContent as { outcome: string; record_id: string; record_hash: string };
    assert.equal(createdOut.outcome, "created");
    // Replay returns the original; the same key with a different payload is refused with the REST problem body.
    const replayed = await write(sofia, { scope: david, facet: "receipts", record: receipt, idempotency_key: "mcp-receipt-1" });
    assert.equal((replayed.structuredContent as { outcome: string; record_id: string }).outcome, "replayed");
    assert.equal((replayed.structuredContent as { record_id: string }).record_id, createdOut.record_id);
    const changed = await write(sofia, { scope: david, facet: "receipts", record: { ...receipt, occurred_at: "2026-09-16T11:00:00Z" }, idempotency_key: "mcp-receipt-1" });
    assert.equal(changed.isError, true);
    const refusal = changed.structuredContent as { status: number; title: string; detail: string };
    assert.equal(refusal.status, 409);
    assert.equal(refusal.title, "idempotency");
    assert.match((changed.content as Array<{ text: string }>)[0]!.text, /refused \[idempotency\] \(409\)/);
    // A smuggled principal in the arguments is ignored: the credential decided who wrote.
    const smuggled = await write(sofia, { scope: david, facet: "receipts", principal: { id: "orc", kind: "service", grants: [acme] }, record: { ...receipt, request_fingerprint: stateHash({ mcp: 2 }) }, idempotency_key: "mcp-receipt-2" });
    assert.equal((smuggled.structuredContent as { outcome: string }).outcome, "created");
    // Outside grants → 403, as a tool error, never a silent empty answer.
    const outside = await sofia.callTool({ name: "nuryel_read", arguments: { scope: acme, subject: "customer:c1" } });
    assert.equal(outside.isError, true);
    assert.equal((outside.structuredContent as { status: number; title: string }).title, "outside-grants");

    // The write is visible to another principal over REST and the other way round: one store, one ledger.
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const rest = await orc.read({ scope: david, subject: "customer:c1" });
    assert.ok(rest.state_of_record!.done.some((r) => r.id === createdOut.record_id));
    const orcMcp = await connect(orcToken);
    const read = await orcMcp.callTool({ name: "nuryel_read", arguments: { scope: david, subject: "customer:c1" } });
    const readOut = read.structuredContent as { state_of_record: { done: Array<{ id: string }> }; records: Record<string, unknown>; envelope: { text: string } };
    assert.ok(readOut.state_of_record.done.some((r) => r.id === createdOut.record_id));
    assert.ok(readOut.records[createdOut.record_id]);
    assert.equal(typeof readOut.envelope.text, "string");
    const events = await orcMcp.callTool({ name: "nuryel_subscribe", arguments: { scope: david, after_seq: 0 } });
    assert.equal((events.structuredContent as { events: unknown[] }).events.length, 2);
    await sofia.close(); await orcMcp.close();
  } finally {
    await cleanup();
  }
});
