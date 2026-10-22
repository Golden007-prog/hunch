import { cleanupDir, isolatedCliEnv, tempDir, writeLocalPointer } from "./fixtures.js";
/**
 * Black-box CLI coverage for subcommands no other test executes end to end:
 * wiki, heal, context, import-adr, export-adr, why, stats, constitution bootstrap.
 * Each runs on a temp git repo after `hunch init --no-providers`, with records
 * seeded as JSON (the source of truth), deterministic synthesis, and no network.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Constraint, Decision } from "../src/core/types.js";
import { hunchCliArgs } from "./cli-invocation.js";

const NOW = new Date(Date.now() - 86_400_000).toISOString();
const DEC_ID = "dec_c11a0001aa";
const DEC_DEAD = "dec_c11a0002bb";
const CON_ID = "con_c11a0003cc";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }

function makeEnv(sandbox: string): NodeJS.ProcessEnv {
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  return isolatedCliEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNC: "1",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    NO_COLOR: "1",
    CI: "1",
  });
}

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ok(f: Fixture, ...args: string[]): Run {
  const r = hunch(f, ...args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function write(f: Fixture, rel: string, text: string): void {
  mkdirSync(join(f.root, rel, ".."), { recursive: true });
  writeFileSync(join(f.root, rel), text);
}

function putRecord(dir: string, kind: string, rec: { id: string }): void {
  mkdirSync(join(dir, kind), { recursive: true });
  writeFileSync(join(dir, kind, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Every file under `root` except git internals and the derived SQLite index. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name.startsWith("hunch.sqlite")) continue;
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(relative(root, file).replace(/\\/g, "/"), readFileSync(file).toString("base64"));
    }
  };
  walk(root);
  return out;
}

function assertUnchanged(before: Map<string, string>, root: string, what: string): void {
  const now = snapshot(root);
  const added = [...now.keys()].filter((k) => !before.has(k));
  const changed = [...now.keys()].filter((k) => before.has(k) && before.get(k) !== now.get(k));
  const removed = [...before.keys()].filter((k) => !now.has(k));
  assert.deepEqual({ added, changed, removed }, { added: [], changed: [], removed: [] }, `${what} must write nothing`);
}

function decision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    title: "Order controllers must use OrderService for persistence",
    topic: "orders.controller-db-boundary",
    status: "accepted",
    context: "A direct controller-to-DB optimization reintroduced the N+1 incident.",
    decision: "Controllers reach persistence through the service boundary.",
    consequences: ["Controllers stay thin."],
    alternatives_rejected: ["Direct database access from controllers."],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/api/orders.ts", "src/services/orders.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: NOW,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-431"] },
    date: NOW,
    ...overrides,
  };
}

function constraint(): Constraint {
  return {
    id: CON_ID, type: "architecture", statement: "API handlers must never import the db client directly", scope: ["src/api/**"],
    severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "service boundary", source_decision: DEC_ID,
    violations: [], status: "active", valid_from: NOW, valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-1"] },
  };
}

function makeRepo(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-a-${label}-`);
  const root = join(sandbox, "repo");
  mkdirSync(root, { recursive: true });
  const f: Fixture = { sandbox, root, env: makeEnv(sandbox) };
  git(f, "init", "-q", "-b", "main");
  git(f, "config", "user.email", "cli-a@example.com");
  git(f, "config", "user.name", "CLI A");
  git(f, "config", "commit.gpgsign", "false");
  git(f, "config", "maintenance.auto", "false");
  git(f, "config", "gc.auto", "0");
  write(f, "package.json", `${JSON.stringify({ name: `cli-a-${label}`, private: true, type: "module" }, null, 2)}\n`);
  write(f, "src/db/client.ts", "export function dbQuery(sql: string) { return sql; }\n");
  write(f, "src/services/orders.ts", 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u: string) { return dbQuery(u); }\n');
  write(f, "src/api/orders.ts", 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u: string) { return fetchOrders(u); }\n');
  git(f, "add", "-A");
  git(f, "commit", "-qm", "fixture: layered orders");
  ok(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: hunch init scaffolding");
  return f;
}

function seedPublic(f: Fixture): void {
  const dir = join(f.root, ".hunch");
  putRecord(dir, "decisions", decision(DEC_ID));
  putRecord(dir, "decisions", decision(DEC_DEAD, {
    title: "Legacy exporter lives in its own module",
    topic: "orders.legacy-exporter",
    decision: "Keep the CSV exporter isolated.",
    related_files: ["src/legacy/exporter.ts"],
    conformance: undefined,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-77"] },
  }));
  putRecord(dir, "constraints", constraint());
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: seed decisions and constraint");
}

function decisionsIn(root: string): Decision[] {
  const dir = join(root, ".hunch", "decisions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Decision);
}

describe("CLI subcommands A (wiki, heal, context, adr, why, stats, bootstrap)", () => {
  let f: Fixture;

  before(() => {
    f = makeRepo("main");
    seedPublic(f);
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  test("cli:why: file target lists the decision and constraint; record id renders the record", () => {
    const byFile = ok(f, "why", "src/api/orders.ts");
    assert.match(byFile.stdout, /^Why "src\/api\/orders\.ts":/m);
    assert.match(byFile.stdout, /DECISIONS:/);
    assert.ok(byFile.stdout.includes(DEC_ID), byFile.stdout);
    assert.ok(byFile.stdout.includes("Controllers reach persistence through the service boundary."), byFile.stdout);
    assert.match(byFile.stdout, /CONSTRAINTS \(must not break\):/);
    assert.ok(byFile.stdout.includes(`${CON_ID} [blocking]`), byFile.stdout);

    const byId = ok(f, "why", DEC_ID);
    assert.ok(byId.stdout.includes("Order controllers must use OrderService for persistence"), byId.stdout);
  });

  test("cli:why: an unresolvable --as-of ref fails with a clear message", () => {
    const r = hunch(f, "why", "src/api/orders.ts", "--as-of", "no-such-ref-xyz");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /could not resolve --as-of "no-such-ref-xyz"/);
  });

  test("cli:context: a file target delivers the decision and invariant brief", () => {
    const r = ok(f, "context", "src/api/orders.ts", "--profile", "reviewer", "--budget", "2000");
    assert.ok(r.stdout.trim().length > 0, "context brief must not be empty");
    assert.ok(r.stdout.includes("API handlers must never import the db client directly") || r.stdout.includes(CON_ID), r.stdout);
    assert.ok(r.stdout.includes(DEC_ID) || r.stdout.includes("Order controllers must use OrderService"), r.stdout);
  });

  test("cli:context: a task phrase falls back to the closest graph matches", () => {
    const r = ok(f, "context", "persistence service boundary");
    assert.match(r.stdout, /No file\/symbol resolves for "persistence service boundary" — closest graph matches instead:/);
  });

  test("cli:context: a bad --profile or --include is refused before any write", () => {
    const before = snapshot(f.root);
    const badProfile = hunch(f, "context", "src/api/orders.ts", "--profile", "janitor");
    assert.notEqual(badProfile.status, 0);
    assert.match(badProfile.stdout + badProfile.stderr, /--profile must be one of: builder, reviewer, architect/);
    const badInclude = hunch(f, "context", "src/api/orders.ts", "--include", "everything");
    assert.notEqual(badInclude.status, 0);
    assert.match(badInclude.stdout + badInclude.stderr, /--include accepts recent-tasks, project-dna \(got: everything\)/);
    assertUnchanged(before, f.root, "refused context");
  });

  test("cli:stats: --json emits the hunch.stats/1 contract counting the seeded records", () => {
    const r = ok(f, "stats", "--json", "--since", "2w");
    const stats = JSON.parse(r.stdout) as { schema: string; window: { since: string }; stock: { decisions: { total: number; accepted: number }; invariants: { total: number; locked: number }; components: number } };
    assert.equal(stats.schema, "hunch.stats/1");
    assert.equal(stats.window.since, "2w");
    assert.equal(stats.stock.decisions.total, 2);
    assert.equal(stats.stock.decisions.accepted, 2);
    assert.equal(stats.stock.invariants.total, 1);
    assert.equal(stats.stock.invariants.locked, 1, "active + blocking + human_confirmed is locked");
    assert.ok(stats.stock.components > 0, "init indexed components");

    const human = ok(f, "stats");
    assert.ok(human.stdout.trim().length > 0);
    assert.equal(human.stdout.trimStart().startsWith("{"), false, "without --json the receipt is human text");
  });

  test("cli:stats: --private without an overlay is refused", () => {
    const r = hunch(f, "stats", "--private");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /--private needs a configured private\/shared overlay/);
  });

  test("cli:heal: reports the dead reference with its next action and writes nothing", () => {
    const before = snapshot(f.root);
    const r = ok(f, "heal");
    assert.match(r.stdout, /dead reference\(s\)/);
    assert.ok(r.stdout.includes(DEC_DEAD), r.stdout);
    assert.match(r.stdout, /Heal: update the decision's related_files/);
    assert.match(r.stdout, /read-only reconciliation report/);
    assertUnchanged(before, f.root, "heal");
  });

  test("cli:heal: an unknown option is refused", () => {
    const r = hunch(f, "heal", "--apply");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown option '--apply'/);
  });

  test("cli:wiki: generates deterministic pages + manifest, then --check reports fresh", () => {
    const r = ok(f, "wiki", "--no-llm");
    assert.match(r.stdout, /page\(s\) written/);
    const wikiDir = join(f.root, "wiki");
    const pages = readdirSync(wikiDir).filter((n) => n.endsWith(".md"));
    assert.ok(pages.length > 0, "wiki pages written");
    const all = pages.map((p) => readFileSync(join(wikiDir, p), "utf8")).join("\n");
    assert.ok(all.includes("Order controllers must use OrderService for persistence"), "public decision reaches the wiki");
    const manifest = JSON.parse(readFileSync(join(f.root, ".hunch", "wiki-manifest.json"), "utf8")) as { dir: string };
    assert.equal(manifest.dir, "wiki");
    // Wiki pages are a derived view: none land inside the memory store.
    assert.equal(readdirSync(join(f.root, ".hunch")).some((n) => n.endsWith(".md")), false);

    const check = ok(f, "wiki", "--check");
    assert.match(check.stdout, /Wiki is fresh/);
  });

  test("cli:wiki: a conflicting --dir and --private without an overlay are refused, nothing written", () => {
    const before = snapshot(f.root);
    const moved = hunch(f, "wiki", "--no-llm", "--dir", "docs/wiki2");
    assert.notEqual(moved.status, 0);
    assert.match(moved.stdout + moved.stderr, /wiki already adopted at "wiki\/"/);
    const priv = hunch(f, "wiki", "--private", "--no-llm");
    assert.notEqual(priv.status, 0);
    assert.match(priv.stdout + priv.stderr, /no private overlay configured/);
    assertUnchanged(before, f.root, "refused wiki");
    assert.equal(existsSync(join(f.root, "docs", "wiki2")), false);
  });

  test("cli:export-adr: writes a marked MADR corpus and a manifest; refuses a hand-written corpus", () => {
    const dry = ok(f, "export-adr", "--dry-run");
    assert.match(dry.stdout, /dry run: would write 2 ADR\(s\) to docs\/adr/);
    assert.equal(existsSync(join(f.root, "docs", "adr")), false, "dry run writes nothing");

    const r = ok(f, "export-adr");
    assert.match(r.stdout, /exported 2 ADR\(s\) to docs\/adr/);
    const files = readdirSync(join(f.root, "docs", "adr")).filter((n) => /^\d+-.*\.md$/.test(n));
    assert.equal(files.length, 2);
    const text = files.map((n) => readFileSync(join(f.root, "docs", "adr", n), "utf8")).join("\n");
    assert.match(text, /hunch:generated/);
    assert.ok(text.includes("Order controllers must use OrderService for persistence"), text);

    write(f, "docs/handwritten/0001-use-postgres.md", "# 1. Use Postgres\n\n## Status\n\nAccepted\n");
    const before = snapshot(f.root);
    const refused = hunch(f, "export-adr", "docs/handwritten");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /docs\/handwritten holds a hand-written ADR corpus \(0001-use-postgres\.md has no hunch:generated marker\)/);
    assertUnchanged(before, f.root, "refused export-adr");
  });

  test("cli:import-adr: an exported corpus round-trips into a fresh repo", () => {
    const g = makeRepo("import");
    try {
      const src = join(f.root, "docs", "adr");
      assert.ok(existsSync(src), "export-adr test must run first");
      cpSync(src, join(g.root, "docs", "adr"), { recursive: true });

      const before = snapshot(g.root);
      const dry = ok(g, "import-adr", "--dry-run");
      assert.match(dry.stdout, /dry run: 2 ADR\(s\) parsed from docs\/adr, nothing written/);
      assertUnchanged(before, g.root, "import-adr --dry-run");

      const r = ok(g, "import-adr");
      assert.match(r.stdout, /imported 2 ADR\(s\) from docs\/adr \(2 new, 0 updated/);
      const imported = decisionsIn(g.root);
      const survivor = imported.find((d) => d.title === "Order controllers must use OrderService for persistence");
      assert.ok(survivor, `round-tripped decision present: ${imported.map((d) => d.title).join(" | ")}`);
      assert.equal(survivor.status, "accepted");
      assert.match(survivor.decision, /Controllers reach persistence through the service boundary/);

      const again = ok(g, "import-adr");
      assert.match(again.stdout, /\(0 new, 2 updated/, "re-import updates the same ids");
      assert.equal(decisionsIn(g.root).length, imported.length);

      const missing = hunch(g, "import-adr", "no/such/dir");
      assert.notEqual(missing.status, 0);
      assert.match(missing.stdout + missing.stderr, /ADR directory not found: no\/such\/dir/);
    } finally {
      cleanupDir(g.sandbox);
    }
  });

  test("cli:constitution bootstrap: compiles a non-active candidate from the human-confirmed predicate", () => {
    const before = snapshot(f.root);
    const bad = hunch(f, "constitution", "bootstrap", "--max-candidates", "0");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /--max-candidates must be a positive number/);
    const badSince = hunch(f, "constitution", "bootstrap", "--since", "forever", "--public-only");
    assert.notEqual(badSince.status, 0);
    assert.match(badSince.stdout + badSince.stderr, /--since must be a positive duration/);
    assertUnchanged(before, f.root, "refused bootstrap");

    const r = ok(f, "constitution", "bootstrap", "--public-only");
    assert.match(r.stdout, /Constitution bootstrap: scanned 2 decision\(s\), 1 eligible/);
    assert.match(r.stdout, /1 compiled/);
    const policyDir = join(f.root, ".hunch", "policies");
    const policies = readdirSync(policyDir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(policyDir, n), "utf8")) as { id: string; state: string });
    assert.equal(policies.length, 1);
    assert.ok(r.stdout.includes(policies[0]!.id));
    assert.notEqual(policies[0]!.state, "active_blocking", "bootstrap never grants authority");

    const second = ok(f, "constitution", "bootstrap", "--public-only");
    assert.match(second.stdout, /0 compiled · 1 already covered/);
  });
});

test("cli:wiki: --private writes the full-graph wiki into the overlay repo; the public wiki never carries overlay records", () => {
  const f = makeRepo("privwiki");
  try {
    putRecord(join(f.root, ".hunch"), "decisions", decision(DEC_ID));
    const overlayRepo = join(f.sandbox, "overlay");
    const overlay = join(overlayRepo, ".hunch");
    mkdirSync(overlay, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: overlayRepo, env: f.env, stdio: "ignore" });
    putRecord(overlay, "decisions", decision("dec_c11a0004dd", {
      title: "Private pricing engine stays in the overlay",
      topic: "private.pricing",
      decision: "SECRET-PRICING-MARKER must never reach the public tree.",
      conformance: undefined,
    }));
    writeLocalPointer(f.root, { privateDir: overlay, autoCommit: false });
    git(f, "add", "-A");
    git(f, "commit", "-qm", "seed");

    const priv = ok(f, "wiki", "--private", "--no-llm");
    assert.match(priv.stdout, /private overlay repo — NOT committed here/);
    assert.equal(existsSync(join(f.root, "wiki")), false, "private wiki must not land in the public work tree");
    const privPages = readdirSync(join(overlayRepo, "wiki")).filter((n) => n.endsWith(".md"));
    assert.ok(privPages.length > 0);
    assert.ok(existsSync(join(overlay, "wiki-manifest.json")));
    assert.equal(existsSync(join(f.root, ".hunch", "wiki-manifest.json")), false);
    assert.equal(git(f, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => /wiki/.test(l)).length, 0);

    ok(f, "wiki", "--no-llm");
    const pub = readdirSync(join(f.root, "wiki")).filter((n) => n.endsWith(".md")).map((n) => readFileSync(join(f.root, "wiki", n), "utf8")).join("\n");
    assert.equal(pub.includes("SECRET-PRICING-MARKER"), false, "public wiki leaked an overlay decision");
    assert.equal(pub.includes("Private pricing engine"), false, "public wiki leaked an overlay title");
  } finally {
    cleanupDir(f.sandbox);
  }
});
