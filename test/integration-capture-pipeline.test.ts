// End-to-end coverage of the capture pipeline's internal edges, driven only through
// the real CLI on a throwaway git repository:
//   synthesis -> store, synthesis -> extractors, extractors -> store (indexer),
//   store -> extractors (check's diff analysis), plus the atomic-write invariant.
// Synthesis is pinned to the deterministic local fallback (HUNCH_SYNTH_PROVIDER=
// deterministic) — never a pay-per-token API (con_2ce3f2a547).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

type Fixture = { sandbox: string; root: string; env: NodeJS.ProcessEnv };

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: f.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, encoding: "utf8", env: f.env, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ok(f: Fixture, ...args: string[]): string {
  const r = hunch(f, ...args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function write(f: Fixture, rel: string, body: string): void {
  mkdirSync(join(f.root, rel, ".."), { recursive: true });
  writeFileSync(join(f.root, rel), body);
}

const BILLING_V1 = [
  'import { round } from "./math.js";',
  "export function legacyTotal(amounts: number[]): number {",
  "  return round(amounts.reduce((a, b) => a + b, 0));",
  "}",
  "",
].join("\n");

const BILLING_V2 = [
  'import { round } from "./math.js";',
  "export function invoiceTotal(amounts: number[], taxRate: number): number {",
  "  const net = amounts.reduce((a, b) => a + b, 0);",
  "  return round(net * (1 + taxRate));",
  "}",
  "export class TaxSchedule {",
  "  rate(region: string): number { return region === \"eu\" ? 0.2 : 0.1; }",
  "}",
  "",
].join("\n");

const MATH = "export function round(n: number): number { return Math.round(n * 100) / 100; }\n";

function makeFixture(label: string): Fixture {
  const sandbox = tempDir(`hunch-capture-pipeline-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1",
    HUNCH_PRIVATE_DIR: "",
    // The post-commit hook `hunch init` installs is backgrounded; its loop guard keeps
    // commits deterministic, and each test runs the hook's exact command in the foreground.
    HUNCH_SYNC: "1",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    NO_COLOR: "1",
    CI: "1",
  });
  const f: Fixture = { sandbox, root, env };
  git(f, "init", "-q", "-b", "main");
  git(f, "config", "user.email", "pipeline@example.com");
  git(f, "config", "user.name", "Pipeline E2E");
  git(f, "config", "commit.gpgsign", "false");
  write(f, "package.json", `${JSON.stringify({ name: `pipeline-${label}`, private: true, type: "module" }, null, 2)}\n`);
  write(f, "src/billing/invoice.ts", BILLING_V1);
  write(f, "src/billing/math.ts", MATH);
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: initial billing module");
  ok(f, "init", "--no-providers", "--no-agent-hooks");
  // Commit init's scaffolding so later commits carry only the code change under test.
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: hunch init scaffolding");
  return f;
}

function decisionsFor(f: Fixture, shortSha: string): Array<Record<string, any>> {
  const dir = join(f.root, ".hunch", "decisions");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, any>)
    .filter((d) => d.commit === shortSha);
}

describe("capture pipeline (CLI end-to-end, deterministic synthesis)", () => {
  let f: Fixture;
  let sha = "";
  let shortSha = "";

  before(() => {
    f = makeFixture("main");
    // A real code change: one symbol retired, two added, one new file.
    write(f, "src/billing/invoice.ts", BILLING_V2);
    write(f, "src/billing/region.ts", 'export const DEFAULT_REGION = "eu";\nexport function regionOf(code: string): string { return code.slice(0, 2); }\n');
    git(f, "add", "-A");
    git(f, "commit", "-qm", "feat(billing): compute invoice totals with regional tax schedule", "-m",
      "Replace legacyTotal with invoiceTotal so tax is applied per region instead of at checkout.");
    sha = git(f, "rev-parse", "HEAD");
    shortSha = git(f, "rev-parse", "--short", "HEAD");
    // Exactly what the installed post-commit hook runs, minus the backgrounding.
    ok(f, "sync", sha, "--from-hook", "--quiet");
  });

  after(() => cleanupDir(f.sandbox));

  test("synthesis->store: init installs the post-commit capture hook that runs `hunch sync --from-hook`", () => {
    const hookPath = git(f, "rev-parse", "--git-path", "hooks/post-commit");
    const hook = readFileSync(join(f.root, hookPath), "utf8");
    assert.match(hook, /sync --from-hook --quiet/);
    assert.match(hook, /HUNCH_SYNC/);
  });

  test("synthesis->store: the post-commit capture writes one Decision JSON with commit provenance", () => {
    const found = decisionsFor(f, shortSha);
    assert.equal(found.length, 1, `expected one decision for ${shortSha}`);
    const d = found[0]!;
    assert.ok(sha.startsWith(d.commit), "decision.commit is the captured commit's sha");
    assert.ok(d.provenance.evidence.includes(`commit:${shortSha}`), JSON.stringify(d.provenance));
    assert.equal(typeof d.provenance.confidence, "number");
    assert.ok(typeof d.title === "string" && d.title.length > 0);
    assert.equal(d.status, "accepted");
    assert.ok(d.valid_from, "valid-time window anchored at the commit date");
  });

  test("synthesis->extractors: the decision's file anchors and retired symbols match the commit diff", () => {
    const d = decisionsFor(f, shortSha)[0]!;
    const changed = git(f, "diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean).sort();
    assert.deepEqual([...d.related_files].sort(), changed);
    assert.deepEqual(changed, ["src/billing/invoice.ts", "src/billing/region.ts"]);
    // The diff analyser saw legacyTotal deleted (Regression Guard input) and nothing else.
    assert.deepEqual(d.retired.symbols, ["legacyTotal"]);
    assert.deepEqual(d.retired.deps, []);
  });

  test("synthesis->store: re-running the capture is idempotent (same id, no duplicate)", () => {
    ok(f, "sync", sha, "--from-hook", "--quiet");
    assert.equal(decisionsFor(f, shortSha).length, 1);
  });

  test("extractors->store: `hunch index` writes parsed symbols and components that `hunch query` finds", () => {
    ok(f, "index", "--no-auto-commit");
    const symbols = JSON.parse(readFileSync(join(f.root, ".hunch", "symbols", "index.json"), "utf8")) as Array<Record<string, any>>;
    const names = new Set(symbols.map((s) => `${s.file}#${s.name}`));
    for (const want of ["src/billing/invoice.ts#invoiceTotal", "src/billing/invoice.ts#TaxSchedule", "src/billing/region.ts#regionOf", "src/billing/math.ts#round"]) {
      assert.ok(names.has(want), `symbol ${want} missing from store: ${[...names].join(", ")}`);
    }
    assert.ok(!names.has("src/billing/invoice.ts#legacyTotal"), "a deleted symbol must not survive a reindex");
    const edges = JSON.parse(readFileSync(join(f.root, ".hunch", "edges", "index.json"), "utf8")) as Array<Record<string, any>>;
    const idOf = (file: string, name: string) => symbols.find((s) => s.file === file && s.name === name)!.id as string;
    const caller = idOf("src/billing/invoice.ts", "invoiceTotal");
    const callee = idOf("src/billing/math.ts", "round");
    assert.ok(
      edges.some((e) => e.from === caller && e.to === callee),
      `the cross-file invoiceTotal -> round call edge was not extracted: ${JSON.stringify(edges.map((e) => [e.from, e.type, e.to]))}`,
    );
    const components = readdirSync(join(f.root, ".hunch", "components")).filter((n) => n.endsWith(".json"));
    assert.ok(components.length > 0, "the indexer derived at least one component");

    const q = ok(f, "query", "invoiceTotal");
    assert.doesNotMatch(q, /No matches/);
    // A hit line is `• [<kind>] <ref> — <title>`; the indexed symbol must be among them.
    assert.ok(q.includes(`• [symbols] ${caller} — invoiceTotal`), `symbol ${caller} not returned by query:\n${q}`);
  });

  test("store->extractors: `hunch check` runs the stored invariant through the diff analyser (content, not scope-touch)", () => {
    ok(f, "record-constraint", "billing must never import axios", "--scope", "src/billing/**", "--severity", "blocking", "--forbid-dep", "axios");
    // In scope but compliant: the analyser finds no forbidden import -> strict check passes.
    write(f, "src/billing/region.ts", 'export const DEFAULT_REGION = "us";\nexport function regionOf(code: string): string { return code.slice(0, 2); }\n');
    git(f, "add", "src/billing/region.ts");
    const clean = hunch(f, "check", "--staged", "--strict");
    assert.equal(clean.status, 0, clean.out);
    // Same scope, now importing the forbidden dep -> the analyser reports it -> strict blocks.
    write(f, "src/billing/region.ts", 'import axios from "axios";\nexport async function regionOf(code: string) { return axios.get(`/r/${code}`); }\n');
    git(f, "add", "src/billing/region.ts");
    const blocked = hunch(f, "check", "--staged", "--strict");
    assert.notEqual(blocked.status, 0, blocked.out);
    assert.match(blocked.out, /axios/);
    git(f, "checkout", "HEAD", "--", "src/billing/region.ts");
  });

  test("atomic write: after capture + index every .hunch/ JSON parses and no temp file remains", () => {
    const files = walk(join(f.root, ".hunch"));
    const json = files.filter((p) => p.endsWith(".json"));
    assert.ok(json.length > 5, `expected a populated store, got ${json.length} JSON files`);
    for (const p of json) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(p, "utf8")), `${relative(f.root, p)} is not valid JSON`);
    }
    const leftovers = files.map((p) => relative(f.root, p)).filter((p) => /\.tmp|~$|\.partial$/i.test(p));
    assert.deepEqual(leftovers, [], "atomic writes must leave no temp files behind");
  });
});
