/**
 * Black-box CLI coverage for subcommands the rest of the suite barely reaches:
 * `embed`, `eval --guards`, `test`, `adopt-drafts`, `auto-review`, `stats`, `served`,
 * and `serve` + `state` (which load src/serve/operator.ts and src/cli/state.ts).
 * Every fixture is a temp git repo after `hunch init --no-providers`; synthesis is forced
 * deterministic, the embedder is `none`/`stub`, and the one server binds an ephemeral
 * loopback port and is killed (and proven gone) in teardown. No model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { recordServed } from "../src/core/served.js";
import { stateHash } from "../src/core/stateContract.js";
import type { Decision } from "../src/core/types.js";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }

function run(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string; out: string } {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, encoding: "utf8", env: { ...f.env, ...extraEnv }, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ok(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const r = run(f, args, extraEnv);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.stdout;
}

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: f.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeFixture(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-b-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDER: "none", HUNCH_STATE_TOKEN: "", NO_COLOR: "1", CI: "1",
  });
  // The outer node:test runner marks children as sub-runners; an inner `node --test`
  // (driven by `hunch test`) would then report to us instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  const f: Fixture = { sandbox, root, env };
  git(f, "init", "-q", "-b", "main");
  git(f, "config", "user.email", "cli-b@example.com");
  git(f, "config", "user.name", "CLI B");
  git(f, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-b-${label}`, private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "src", "auth", "session.ts"), "export function verifySession(t: string): string { return t; }\n");
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: initial auth module");
  ok(f, ["init", "--no-providers", "--no-agent-hooks"]);
  return f;
}

function decision(id: string, over: Partial<Decision> = {}): Decision {
  const now = "2026-07-19T12:00:00.000Z";
  return {
    id, title: "Sessions are verified with signed tokens", topic: null, status: "accepted",
    context: "Session verification happens at the auth boundary.",
    decision: "Verify every session with a signed token before routing the request.",
    consequences: [], alternatives_rejected: ["Opaque cookies looked up per request."], rejected_tripwires: [],
    related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: now, valid_to: null, retired: { symbols: [], deps: [] },
    conformance: [], provenance: { source: "human_confirmed", confidence: 1, evidence: ["review:auth"] }, date: now,
    ...over,
  } as Decision;
}

function seed(f: Fixture, put: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(f.root));
  try { put(store); store.reindex(); } finally { store.close(); }
}

const readDecision = (f: Fixture, id: string): Decision => JSON.parse(readFileSync(join(f.root, ".hunch", "decisions", `${id}.json`), "utf8")) as Decision;

test("cli:embed: degrades with a clear message when no embedder is installed, keyword query still works, and a stub embedder embeds idempotently", () => {
  const f = makeFixture("embed");
  try {
    seed(f, (s) => s.json.put("decisions", decision("dec_embed_anchor")));
    const degraded = run(f, ["embed"]);
    assert.equal(degraded.status, 0, degraded.out);
    assert.match(degraded.stdout, /needs a local embedding model, which isn't installed/);
    assert.match(degraded.stdout, /fast keyword \(FTS\) search/);
    const q = ok(f, ["query", "signed tokens"]);
    assert.match(q, /dec_embed_anchor/, "FTS still finds the decision without embeddings");

    const first = ok(f, ["embed"], { HUNCH_EMBEDDER: "stub" });
    assert.match(first, /✓ embedded \d+ doc\(s\).*Model: stub-v1/);
    assert.match(ok(f, ["embed"], { HUNCH_EMBEDDER: "stub" }), /already embedded \(model stub-v1\)\. Nothing to do\./);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:eval: --guards scores a generated golden set through the real gate and refuses a missing or malformed set", () => {
  const f = makeFixture("eval");
  try {
    seed(f, (s) => s.json.put("constraints", mkConstraint({ id: "con_eval_auth", statement: "Auth code never imports the legacy session store", severity: "blocking", forbids: { deps: ["legacy-session-store"], symbols: [] } as never })));
    const golden = join(f.sandbox, "guards.json");
    const out = ok(f, ["eval", "--guards", "--generate", "--file", golden]);
    assert.match(out, /Guard eval over \d+ case\(s\)/);
    assert.match(out, /CAUGHT\s+1\/1/);
    assert.match(out, /FALSE-POSITIVE\s+0\//);
    const cases = JSON.parse(readFileSync(golden, "utf8")) as Array<{ name: string; expect: string; files: string[] }>;
    assert.ok(cases.some((c) => c.expect !== "pass" && c.files[0]!.startsWith("src/auth/")), JSON.stringify(cases));
    assert.ok(cases.some((c) => c.expect === "pass"));

    const missing = run(f, ["eval", "--guards"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /guard eval needs --file/);
    const bad = join(f.sandbox, "bad.json");
    writeFileSync(bad, JSON.stringify([{ name: "x", files: ["a.ts"], expect: "maybe" }]));
    const malformed = run(f, ["eval", "--guards", "--file", bad]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /guard eval: case 0/);
    const retrieval = run(f, ["eval"]);
    assert.notEqual(retrieval.status, 0);
    assert.match(retrieval.stderr, /retrieval eval needs --file/);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:test: a failing TAP run is captured as a bug and keeps a non-zero exit; --dry-run writes nothing", () => {
  const f = makeFixture("test");
  try {
    writeFileSync(join(f.root, "auth.test.mjs"), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("session token round-trips", () => { assert.equal(1, 2); });',
      'test("session id is stable", () => { assert.equal(1, 1); });',
      "",
    ].join("\n"));
    const cmd = ["node", "--test", "--test-reporter=tap", "auth.test.mjs"];
    const bugsDir = join(f.root, ".hunch", "bugs");
    const before = readdirSync(bugsDir).length;
    const dry = run(f, ["test", "--dry-run", "--", ...cmd]);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.stdout, /DRY RUN — exit 1, 1 passed, 1 failure\(s\)/);
    assert.match(dry.stdout, /✗ session token round-trips/);
    assert.equal(readdirSync(bugsDir).length, before, "dry run writes no bug");

    const real = run(f, ["test", "--", ...cmd]);
    assert.equal(real.status, 1, real.out);
    assert.match(real.stdout, /✗ suite failed — 1 bug\(s\) captured/);
    const bugs = readdirSync(bugsDir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(bugsDir, n), "utf8")) as { title: string });
    assert.equal(bugs.length, before + 1);
    assert.ok(bugs.some((b) => /session token round-trips/.test(b.title)), JSON.stringify(bugs));

    const priv = run(f, ["test", "--private", "--", ...cmd]);
    assert.notEqual(priv.status, 0);
    assert.match(priv.stderr, /--private needs HUNCH_PRIVATE_DIR/);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:adopt-drafts: dry run lists drafts unchanged, apply flips them to accepted advisory, and it is idempotent", () => {
  const f = makeFixture("adopt");
  try {
    seed(f, (s) => s.json.put("decisions", decision("dec_adopt_draft", { status: "proposed", provenance: { source: "llm_draft", confidence: 0.6, evidence: [] } })));
    const dry = ok(f, ["adopt-drafts", "--dry-run"]);
    assert.match(dry, /Would adopt 1 draft\(s\)/);
    assert.match(dry, /dec_adopt_draft/);
    assert.equal(readDecision(f, "dec_adopt_draft").status, "proposed");

    assert.match(ok(f, ["adopt-drafts"]), /Adopted 1 draft\(s\)/);
    const adopted = readDecision(f, "dec_adopt_draft");
    assert.equal(adopted.status, "accepted");
    assert.equal(adopted.provenance.source, "llm_draft", "source is unchanged so it still never blocks");
    assert.match(ok(f, ["adopt-drafts"]), /No un-vouched drafts/);

    const priv = run(f, ["adopt-drafts", "--private"]);
    assert.notEqual(priv.status, 0);
    assert.match(priv.stderr, /--private needs HUNCH_PRIVATE_DIR/);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:auto-review: refuses --apply on an unjudged batch, and --no-llm --apply rejects a deterministic duplicate", () => {
  const f = makeFixture("autoreview");
  try {
    seed(f, (s) => {
      s.json.put("decisions", decision("dec_ar_anchor"));
      s.json.put("decisions", decision("dec_ar_dup", { status: "proposed", provenance: { source: "llm_draft", confidence: 0.5, evidence: [] } }));
    });
    const dry = ok(f, ["auto-review"]);
    assert.match(dry, /REJECT \(duplicate\)/);
    assert.match(dry, /near-duplicate of dec_ar_anchor/);
    assert.match(dry, /Dry run — nothing changed/);

    const refused = run(f, ["auto-review", "--apply"]);
    assert.notEqual(refused.status, 0, refused.out);
    assert.match(refused.stderr, /incomplete harness batch/);
    assert.equal(readDecision(f, "dec_ar_dup").status, "proposed", "a refused apply mutates nothing");

    const applied = ok(f, ["auto-review", "--no-llm", "--apply"]);
    assert.match(applied, /auto-review applied: 0 accepted, 1 rejected, 0 kept/);
    const rejected = readDecision(f, "dec_ar_dup");
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.valid_to, "rejection is a lifecycle tombstone");
    assert.equal(readDecision(f, "dec_ar_anchor").status, "accepted");
    assert.match(ok(f, ["auto-review", "--no-llm"]), /No drafts to auto-review/);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:stats: --json emits the hunch.stats/1 contract over the seeded graph, text renders, --private is refused", () => {
  const f = makeFixture("stats");
  try {
    seed(f, (s) => {
      s.json.put("decisions", decision("dec_stats_a"));
      s.json.put("decisions", decision("dec_stats_b", { status: "proposed", provenance: { source: "llm_draft", confidence: 0.5, evidence: [] } }));
      s.json.put("constraints", mkConstraint({ id: "con_stats_locked", severity: "blocking" }));
      s.json.put("constraints", mkConstraint({ id: "con_stats_adv" }));
    });
    const stats = JSON.parse(ok(f, ["stats", "--json", "--since", "24h"])) as Record<string, any>;
    assert.equal(stats.schema, "hunch.stats/1");
    assert.equal(stats.window.since, "24h");
    assert.equal(stats.stock.decisions.total, 2);
    assert.equal(stats.stock.decisions.accepted, 1);
    assert.equal(stats.stock.decisions.proposed, 1);
    assert.equal(stats.stock.invariants.total, 2);
    assert.equal(stats.stock.invariants.locked, 1);
    assert.equal(typeof stats.compounding.payback_ratio, "number");
    assert.ok(ok(f, ["stats"]).trim().length > 0);
    const priv = run(f, ["stats", "--private"]);
    assert.notEqual(priv.status, 0);
    assert.match(priv.stderr, /--private needs a configured private\/shared overlay/);
  } finally { cleanupDir(f.sandbox); }
});

test("cli:served: empty ledger says so, then summarises seeded delivery receipts in text and JSON", () => {
  const f = makeFixture("served");
  try {
    seed(f, (s) => s.json.put("decisions", decision("dec_served_a")));
    assert.match(ok(f, ["served"]), /No delivery receipts yet/);
    assert.equal((JSON.parse(ok(f, ["served", "--json"])) as { total: number }).total, 0);
    recordServed(f.root, [
      { event: "served", kind: "decisions", record_id: "dec_served_a", target: "src/auth/session.ts", session_id: "s1", rank: 1 },
      { event: "served", kind: "decisions", record_id: "dec_served_a", target: "src/auth/session.ts", session_id: "s2", rank: 2 },
    ]);
    const json = JSON.parse(ok(f, ["served", "--json"])) as { total: number; distinct_records: number; distinct_sessions: number; rows: Array<{ record_id: string; serves: number }> };
    assert.equal(json.total, 2);
    assert.equal(json.distinct_records, 1);
    assert.equal(json.distinct_sessions, 2);
    assert.equal(json.rows[0]!.record_id, "dec_served_a");
    const text = ok(f, ["served"]);
    assert.match(text, /2 deliveries · 1 distinct record/);
    assert.match(text, /dec_served_a.*Sessions are verified with signed tokens/);
  } finally { cleanupDir(f.sandbox); }
});

// ---- serve + state (src/serve/operator.ts, src/cli/state.ts) ----------------

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** A long-running CLI as ONE process (no tsx wrapper child), so kill() leaves no orphan. */
function directCliArgs(...args: string[]): string[] {
  if (process.env.HUNCH_TEST_COMPILED_CLI === "1") return hunchCliArgs(...args);
  return ["--import", tsxLoaderUrl(), join(process.cwd(), "src/cli/index.ts"), ...args];
}

async function waitForHealth(base: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`hunch serve exited ${child.exitCode}:\n${log()}`);
    try { if ((await fetch(`${base}/nuryel/v1/health`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`hunch serve never became healthy:\n${log()}`);
}

async function stopServer(child: ChildProcess, base: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  const alive = await fetch(`${base}/nuryel/v1/health`).then(() => true, () => false);
  assert.equal(alive, false, "the served port is closed after teardown");
}

function runAsync(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
  });
}

test("cli:serve + cli:state: serve init mints a token, the operator shell is served, and the state CLI round-trips capabilities/write/read/records/subscribe with refusals", async () => {
  const f = makeFixture("serve");
  const config = join(f.sandbox, "hunch-serve.json");
  const partitionRoot = join(f.sandbox, "david");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let serverLog = "";
  try {
    const init = JSON.parse(ok(f, ["serve", "init", "--partition", "user:david", "--root", partitionRoot, "--config", config, "--principal", "agent@david", "--port", String(port), "--json"])) as { token: string; partition: { root: string } };
    assert.match(init.token, /\S{16,}/);
    assert.ok(existsSync(join(partitionRoot, ".hunch", "partition.json")));
    assert.ok(!readFileSync(config, "utf8").includes(init.token), "only the token hash is stored");
    const badInit = run(f, ["serve", "init", "--partition", "nope", "--root", partitionRoot, "--config", config]);
    assert.notEqual(badInit.status, 0);
    assert.match(badInit.out, /partition must be kind:id/);

    server = spawn(process.execPath, directCliArgs("serve", "--config", config), { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; });
    await waitForHealth(base, server, () => serverLog);

    for (const [path, type] of [["/operator", "text/html"], ["/operator.css", "text/css"], ["/operator.js", "text/javascript"]] as const) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", new RegExp(type));
      assert.ok((await res.text()).length > 100, `${path} has a body`);
    }

    const tokenFile = join(f.sandbox, "token.txt");
    writeFileSync(tokenFile, init.token);
    const common = ["state", "--url", base, "--token-file", tokenFile];
    // cli-surface detection markers (argv is built from `common`): ["state", "capabilities"] ["state", "write"] ["state", "records"] ["state", "read"] ["state", "subscribe"]
    const caps = await runAsync(f, [...common, "capabilities"], {});
    assert.equal(caps.status, 0, caps.stderr);
    const capsJson = JSON.parse(caps.stdout) as { principal: { id: string }; capabilities: string[] };
    assert.equal(capsJson.principal.id, "agent@david");
    assert.ok(capsJson.capabilities.includes("nuryel.state.write/1"));

    const david = { kind: "user", id: "david" };
    const receipt = {
      schema: "nuryel.receipt/1", scope: david, actor: "agent@david", action_kind: "add_comment",
      target: { system: "crm", object_type: "event", object_key: "10042", observed_at: "2026-09-08T10:00:00Z" },
      request_fingerprint: stateHash({ c: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z",
      provenance: { source: "imported:cli-test", confidence: 0.9, evidence: ["row a1"] }, invalidates: ["customer:c1"],
    };
    const writeFile = join(f.sandbox, "write.json");
    writeFileSync(writeFile, JSON.stringify({ scope: david, facet: "receipts", record: receipt, idempotency_key: "cli-b-write-1" }));
    const write = await runAsync(f, [...common, "write", "--input", writeFile], {});
    assert.equal(write.status, 0, write.stderr);
    const written = JSON.parse(write.stdout) as { outcome: string; record_id: string };
    assert.equal(written.outcome, "created");
    const replay = await runAsync(f, [...common, "write", "--input", writeFile], {});
    assert.equal((JSON.parse(replay.stdout) as { outcome: string }).outcome, "replayed");

    const records = await runAsync(f, [...common, "records", "--scope", "user:david", "--ids", written.record_id], {});
    assert.equal(records.status, 0, records.stderr);
    assert.match(records.stdout, new RegExp(written.record_id));
    const read = await runAsync(f, [...common, "read", "--scope", "user:david", "--subject", "customer:c1"], {});
    assert.equal(read.status, 0, read.stderr);
    assert.ok(JSON.parse(read.stdout));
    const sub = await runAsync(f, [...common, "subscribe", "--scope", "user:david", "--after", "0"], {});
    assert.equal(sub.status, 0, sub.stderr);
    assert.ok((JSON.parse(sub.stdout) as { head_seq: number }).head_seq >= 1);

    // Refusals: no token, a wrong token (server 401), malformed shortcut scope, mixed input.
    const noToken = await runAsync(f, ["state", "--url", base, "capabilities"], { HUNCH_STATE_TOKEN: "" });
    assert.equal(noToken.status, 1);
    assert.match(JSON.parse(noToken.stderr).detail, /set HUNCH_STATE_TOKEN or pass --token-file/);
    const wrong = await runAsync(f, ["state", "--url", base, "capabilities"], { HUNCH_STATE_TOKEN: "nyt_wrong" });
    assert.equal(wrong.status, 1);
    assert.equal(JSON.parse(wrong.stderr).status, 401);
    const badScope = await runAsync(f, [...common, "read", "--scope", "david"], {});
    assert.equal(badScope.status, 1);
    assert.match(JSON.parse(badScope.stderr).detail, /pass --scope kind:id/);
    const mixed = await runAsync(f, [...common, "records", "--input", writeFile, "--scope", "user:david"], {});
    assert.equal(mixed.status, 1);
    assert.match(JSON.parse(mixed.stderr).detail, /either --input JSON or shortcut options/);
  } finally {
    if (server) await stopServer(server, base);
    cleanupDir(f.sandbox);
  }
});
