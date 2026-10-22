/**
 * Black-box CLI coverage for read-mostly subcommands: `compare`, `evidence-map`, `firmness`,
 * `footprint`, `fragile`, `impact`, `merge-driver-grounding`, `path`, `reconcile-topics`,
 * `serve compact` / `serve revoke`, `shortlist`, `structure`, `task forget` / `prune` /
 * `rank-eval`, `timeline`, `workspaces list` and retrieval `eval`.
 * One temp git repo (three source files, a short history, a feature branch) after
 * `hunch init --no-providers` + `hunch index`, seeded with a decision and a constraint.
 * Tests share it and run in file order; synthesis is deterministic, no model, no network.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { mkConstraint } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { appendChanges, ledgerFile, readLedger } from "../src/store/changeLedger.js";
import type { Decision } from "../src/core/types.js";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
let f: Fixture;

function run(args: string[], cwd = f.root): { status: number | null; stdout: string; stderr: string; out: string } {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd, encoding: "utf8", env: f.env, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ok(args: string[], cwd = f.root): string {
  const r = run(args, cwd);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.stdout;
}

function refused(args: string[], pattern: RegExp, cwd = f.root): void {
  const r = run(args, cwd);
  assert.notEqual(r.status, 0, `hunch ${args.join(" ")} should refuse:\n${r.out}`);
  assert.match(r.out, pattern);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: f.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function decision(id: string, over: Partial<Decision> = {}): Decision {
  const now = "2026-07-19T12:00:00.000Z";
  return {
    id, title: "Sessions are verified with signed tokens", topic: "auth.sessions", status: "accepted",
    context: "Session verification happens at the auth boundary.",
    decision: "Verify every session with a signed token before routing the request.",
    consequences: [], alternatives_rejected: ["Opaque cookies looked up per request."], rejected_tripwires: [],
    related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: now, valid_to: null, retired: { symbols: [], deps: [] },
    conformance: [], provenance: { source: "human_confirmed", confidence: 1, evidence: ["review:auth"] }, date: now,
    ...over,
  } as Decision;
}

function seed(put: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(f.root));
  try { put(store); store.reindex(); } finally { store.close(); }
}

before(() => {
  const sandbox = tempDir("hunch-cli-c-");
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "src", "api"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDER: "none", HUNCH_STATE_TOKEN: "", NO_COLOR: "1", CI: "1",
  });
  delete env.NODE_TEST_CONTEXT;
  f = { sandbox, root, env };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "cli-c@example.com");
  git("config", "user.name", "CLI C");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "cli-c", private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "src", "auth", "token.ts"), "export function signToken(t: string): string { return `signed:${t}`; }\n");
  git("add", "-A");
  git("commit", "-qm", "chore: token signing");
  writeFileSync(join(root, "src", "auth", "session.ts"), 'import { signToken } from "./token.js";\nexport function verifySession(t: string): string { return signToken(t); }\n');
  git("add", "-A");
  git("commit", "-qm", "feat: verify sessions with signed tokens");
  writeFileSync(join(root, "src", "api", "routes.ts"), 'import { verifySession } from "../auth/session.js";\nexport function route(t: string): string { return verifySession(t); }\n');
  git("add", "-A");
  git("commit", "-qm", "feat: route requests through session verification");
  ok(["init", "--no-providers", "--no-agent-hooks"]);
  seed((s) => {
    s.json.put("decisions", decision("dec_c_auth"));
    s.json.put("constraints", mkConstraint({ id: "con_c_auth", statement: "Auth code never imports the legacy session store", severity: "blocking", scope: ["src/auth/**"], forbids: { deps: ["legacy-session-store"], symbols: [] } as never }));
  });
  ok(["index"]);
  git("add", "-A");
  git("commit", "-qm", "chore: hunch memory", "--allow-empty");
  git("checkout", "-q", "-b", "feat-a");
  writeFileSync(join(root, "src", "api", "routes.ts"), 'import { verifySession } from "../auth/session.js";\nexport function route(t: string): string { return verifySession(t.trim()); }\n');
  git("commit", "-qam", "feat: trim tokens before routing");
  git("checkout", "-q", "main");
});

after(() => { if (f) cleanupDir(f.sandbox); });

test("cli:compare: ranks a candidate branch against main and refuses an unknown base", () => {
  const out = ok(["compare", "feat-a", "--base", "main"]);
  assert.match(out, /Candidates vs main/);
  assert.match(out, /1\. .*feat-a\s+\[(pass|warn|block)\].*\(1 files\)/);
  refused(["compare", "feat-a", "--base", "nope"], /base ref "nope" not found/);
});

test("cli:evidence-map: compiles an authenticated receipt to JSON and refuses an invalid one", () => {
  const receipt = join(f.sandbox, "receipt.json");
  writeFileSync(receipt, JSON.stringify({
    version: 1, claim: "Routing preserves the session token.",
    probe: { target_before: "red", control_before: "green", target_after: "green", control_after: "green" },
    execution: [{ owner: "src/auth/session.ts::verifySession", target_count: 3, control_count: 0 }],
    interventions: [{ owner: "src/auth/session.ts::verifySession", mutation_id: "m1", target_after: "green", control_after: "green" }],
  }));
  const map = JSON.parse(ok(["evidence-map", receipt, "--json"])) as { level: string; owner_claim: { enabled: boolean }; files: Array<{ path: string }> };
  assert.equal(map.level, "behavior-sensitive");
  assert.equal(map.owner_claim.enabled, false);
  assert.deepEqual(map.files.map((x) => x.path), ["src/auth/session.ts"]);
  assert.match(ok(["evidence-map", receipt]), /Exact-owner claim: disabled/);
  const bad = join(f.sandbox, "bad-receipt.json");
  writeFileSync(bad, JSON.stringify({ version: 2 }));
  refused(["evidence-map", bad], /could not compile the verified evidence map/);
});

test("cli:firmness: prints the level as JSON, persists a new level to config, and refuses an unknown level", () => {
  const before = JSON.parse(ok(["firmness", "--json"])) as { firmness: string; levels: string[] };
  assert.deepEqual(before.levels, ["off", "advisory", "firm", "strict"]);
  assert.match(ok(["firmness", "strict"]), /firmness set to strict/);
  assert.equal((JSON.parse(readFileSync(join(f.root, ".hunch", "config.json"), "utf8")) as { firmness: string }).firmness, "strict");
  assert.match(ok(["firmness"]), /firmness: strict/);
  refused(["firmness", "bogus"], /firmness must be one of: off, advisory, firm, strict/);
  ok(["firmness", before.firmness]);
});

test("cli:footprint: measures the injected surfaces as hunch.footprint JSON and as a table", () => {
  const report = JSON.parse(ok(["footprint", "--json"])) as { surfaces: Array<{ id: string; chars: number; est_tokens: number }>; unmeasured: string[] };
  assert.ok(report.surfaces.length > 0);
  for (const s of report.surfaces) assert.ok(Math.abs(s.est_tokens - s.chars / 4) <= 1, JSON.stringify(s));
  assert.match(ok(["footprint"]), /Tokens estimated as characters \/ 4/);
});

test("cli:fragile: prints a fragility report (or the no-signal notice) for the indexed repo", () => {
  const out = ok(["fragile", "--limit", "5"]);
  assert.match(out, /Most fragile symbols|No fragility signal yet/);
});

test("cli:impact: reports a single commit's surface and refuses ambiguous or unresolvable inputs", () => {
  const out = ok(["impact", "--commit", "feat-a"]);
  assert.match(out, /routes\.ts|commit feat-a/);
  refused(["impact", "main", "--commit", "feat-a"], /Pass exactly one of \[base\] \/ --commit \/ --working/);
  refused(["impact", "no-such-ref"], /base ref "no-such-ref" does not resolve/);
  assert.match(ok(["impact"]), /No changed files in staged changes/);
});

test("cli:merge-driver-grounding: resolves a counts-only conflict to the max and leaves a prose conflict for a human", () => {
  const counts = (n: number) => `This repo has **Hunch** — a curated graph. It currently holds **${n} decisions, 2 bugs, 28 constraints, 21 components, 3 policies**.`;
  const dir = join(f.sandbox, "mdg");
  mkdirSync(dir, { recursive: true });
  const [O, A, B] = ["base.md", "ours.md", "theirs.md"].map((n) => join(dir, n)) as [string, string, string];
  writeFileSync(O, `intro\n${counts(240)}\noutro\n`);
  writeFileSync(A, `intro\n${counts(241)}\noutro\n`);
  writeFileSync(B, `intro\n${counts(243)}\noutro\n`);
  ok(["merge-driver-grounding", O, A, B, "CLAUDE.md"]);
  assert.equal(readFileSync(A, "utf8"), `intro\n${counts(243)}\noutro\n`);

  writeFileSync(O, "intro\nshared line\noutro\n");
  writeFileSync(A, "intro\nours rewrote this\noutro\n");
  writeFileSync(B, "intro\ntheirs rewrote this\noutro\n");
  const conflict = run(["merge-driver-grounding", O, A, B, "CLAUDE.md"]);
  assert.equal(conflict.status, 1, conflict.out);
  const marked = readFileSync(A, "utf8");
  assert.match(marked, /<<<<<<< ours/);
  assert.match(marked, />>>>>>> theirs/);
});

test("cli:path: finds an import path between two files and refuses an unindexed endpoint", () => {
  const r = run(["path", "src/api/routes.ts", "src/auth/token.ts"]);
  if (r.status === 0) assert.match(r.stdout, /\d+ hop\(s\):/);
  else assert.match(r.stdout, /No path between/);
  refused(["path", "src/api/routes.ts", "nowhere_symbol_xyz"], /"nowhere_symbol_xyz" resolves to no indexed symbol\/component/);
});

test("cli:shortlist: emits a JSON diagnostic with scan stats and refuses an out-of-range limit", () => {
  const diag = JSON.parse(ok(["shortlist", "session", "token", "verification", "fails", "--json"])) as { scan: { files_read: number } };
  assert.ok(diag.scan.files_read >= 1, JSON.stringify(diag.scan));
  refused(["shortlist", "session", "--limit", "9"], /--limit must be an integer from 1 to 5/);
});

test("cli:structure: prints the repo map and a file's shape from the graph", () => {
  assert.match(ok(["structure"]), /src/);
  assert.match(ok(["structure", "src/auth/session.ts"]), /verifySession|session\.ts/);
});

test("cli:timeline: lists a file's decision history and says so when there is none", () => {
  const out = ok(["timeline", "src/auth/session.ts"]);
  assert.match(out, /Decision timeline for "src\/auth\/session\.ts"/);
  assert.match(out, /dec_c_auth \[accepted\]/);
  assert.match(ok(["timeline", "src/nothing.ts"]), /No decision history for "src\/nothing\.ts" yet/);
});

test("cli:workspaces list: emits this machine's worktree as JSON and refuses outside a git repo", () => {
  const view = JSON.parse(ok(["workspaces", "list", "--json"])) as { machine: string; worktrees: Array<{ branch?: string }> };
  assert.ok(view.machine);
  assert.ok(view.worktrees.length >= 1, JSON.stringify(view));
  const outside = join(f.sandbox, "not-git");
  mkdirSync(outside, { recursive: true });
  refused(["workspaces", "list"], /needs a git repo/, outside);
});

test("cli:eval: retrieval scoring over a small golden set, refusing an empty or malformed set", () => {
  const golden = join(f.sandbox, "golden.json");
  writeFileSync(golden, JSON.stringify([{ query: "signed tokens session verification", expected: ["dec_c_auth"] }]));
  const out = ok(["eval", "--file", golden, "--k", "5"]);
  assert.match(out, /Eval over 1 case\(s\), k=5 \(FTS \+ graph\)/);
  assert.match(out, /Recall@5/);
  const empty = join(f.sandbox, "empty.json");
  writeFileSync(empty, "[]");
  refused(["eval", "--file", empty], /golden set is empty/);
  const malformed = join(f.sandbox, "malformed.json");
  writeFileSync(malformed, JSON.stringify([{ query: 1 }]));
  refused(["eval", "--file", malformed], /could not load golden set: golden case 0/);
});

test("cli:task rank-eval: scores task-record ranking offline as JSON", () => {
  const report = JSON.parse(ok(["task", "rank-eval", "--json"])) as Record<string, unknown>;
  assert.equal(typeof report, "object");
  assert.ok(report && Object.keys(report).length > 0);
});

test("cli:task forget: refuses an open task, then removes a closed task's report history", () => {
  const started = JSON.parse(ok(["task", "start", "CLI C forget probe"])) as { task_id: string };
  assert.match(started.task_id, /^htask_/);
  refused(["task", "forget", started.task_id], /close the task before deleting its report history/);
  ok(["task", "finish", started.task_id]);
  assert.match(ok(["task", "forget", started.task_id]), /Task report history removed; project memory retained\./);
  const listed = JSON.parse(ok(["task", "list", "--json"])) as Array<{ task: { task_id: string } }>;
  assert.ok(!listed.some((s) => s.task.task_id === started.task_id), "forgotten task no longer listed");
});

test("cli:task prune: removes nothing inside the retention window and refuses an out-of-range retention", () => {
  assert.match(ok(["task", "prune", "--days", "90"]), /Removed 0 expired task report\(s\)\./);
  refused(["task", "prune", "--days", "0"], /retention must be 1–3650 days/);
});

test("cli:serve compact: compacts a served partition's ledger and refuses an unserved partition", () => {
  const partRoot = join(f.sandbox, "part-compact");
  const config = join(f.root, "hunch-serve.json"); // the default config resolved against cwd
  ok(["serve", "init", "--partition", "user:cc", "--root", partRoot, "--principal", "agent@cc", "--json"]);
  const scope = { kind: "user" as const, id: "cc" };
  const hunchDir = join(partRoot, ".hunch");
  const hash = (c: string) => `sha256:${c.repeat(64)}`;
  appendChanges(hunchDir, scope, ["a", "b", "c"].map((c) => ({ facet: "decisions" as const, record_id: `dec_${c}`, record_hash: hash(c), change: "created" as const, invalidates: [] })), null);
  assert.ok(existsSync(ledgerFile(hunchDir, scope)));
  const res = JSON.parse(ok(["serve", "compact", "--partition", "user:cc", "--keep", "1", "--json"])) as { partition: string; dropped: number; floor_seq: number; head_seq: number };
  assert.deepEqual(res, { partition: "user/cc", dropped: 2, floor_seq: 2, head_seq: 3 });
  assert.equal(readLedger(hunchDir, scope).events.length, 1);
  assert.match(ok(["serve", "compact", "--partition", "user:cc", "--keep", "5"]), /nothing to compact/);
  refused(["serve", "compact", "--partition", "user:nobody"], /does not serve user\/nobody/);
  refused(["serve", "compact", "--partition", "user:cc", "--keep", "-1"], /--keep must be a non-negative integer/);
  assert.ok(existsSync(config));
});

test("cli:serve revoke: removes a principal's credential from the config and refuses an unknown principal", () => {
  const config = join(f.root, "hunch-serve.json");
  ok(["serve", "init", "--partition", "user:cc", "--root", join(f.sandbox, "part-compact"), "--principal", "agent@rv", "--json"]);
  const principals = () => (JSON.parse(readFileSync(config, "utf8")) as { principals: Array<{ id: string }> }).principals.map((p) => p.id);
  assert.ok(principals().includes("agent@rv"));
  assert.deepEqual(JSON.parse(ok(["serve", "revoke", "--principal", "agent@rv"])), { revoked: "agent@rv" });
  assert.ok(!principals().includes("agent@rv"));
  assert.ok(principals().includes("agent@cc"), "other principals survive");
  refused(["serve", "revoke", "--principal", "agent@rv"], /principal is not configured/);
});

test("cli:reconcile-topics: clean graph exits 0; two live decisions on one topic exit non-zero naming both", () => {
  assert.match(ok(["reconcile-topics"]), /No topic collisions/);
  seed((s) => s.json.put("decisions", decision("dec_c_auth_two", { title: "Sessions are verified by an opaque lookup", decision: "Look sessions up per request." })));
  const r = run(["reconcile-topics"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /topic "auth\.sessions"/);
  assert.match(r.stderr, /dec_c_auth\b/);
  assert.match(r.stderr, /dec_c_auth_two/);
});
