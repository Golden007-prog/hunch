import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { prov } from "./helpers.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { findingId } from "../src/core/ids.js";
import type { Decision, Finding } from "../src/core/types.js";

/** Black-box coverage for a second batch of miscellaneous CLI flags (init setup
 *  switches, task-report lesson paging/export, grounding --force, shortlist
 *  --evidence, wiki prose opt-ins, findings --all, path --max-depth, footprint
 *  --target, impact --working, check --blast, import-adr --private, runbook
 *  --semantic). Every run is on a temp repo with the deterministic provider and no
 *  embedder; no model or network is reached. */

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string }

const DETECTED_BINARIES = ["cursor", "cursor-agent", "code", "code-insiders", "codex", "windsurf", "antigravity"];

/** PATH without any directory that would make an assistant "detected", so init's
 *  assistant selection depends only on what the fixture puts in the repo. */
function neutralPath(): string {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const exts = ["", ".exe", ".cmd", ".bat"];
  return raw.split(delimiter).filter((dir) => dir && !DETECTED_BINARIES.some((n) => exts.some((e) => existsSync(join(dir, n + e))))).join(delimiter);
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, extraEnv: NodeJS.ProcessEnv, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extraEnv }, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function ok(r: Run, what: string): string {
  assert.equal(r.status, 0, `${what} must succeed:\n${r.out}`);
  return r.out;
}

function refused(r: Run, pattern: RegExp, what: string): void {
  assert.notEqual(r.status, 0, `${what} must exit non-zero:\n${r.out}`);
  assert.match(r.out, pattern, `${what} must explain the refusal`);
}

/** A temp git repo with one commit; `init` runs only when asked (init tests drive it themselves). */
function makeRepo(label: string, opts: { init?: boolean; files?: Record<string, string> } = {}): Fixture {
  const sandbox = tempDir(`hunch-cli-misc2-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const base = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
  for (const key of Object.keys(base)) if (key.toLowerCase() === "path") delete base[key];
  const env: NodeJS.ProcessEnv = { ...base, PATH: neutralPath() };
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "misc2@example.com"], ["user.name", "Misc2"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(root, env, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-misc2-${label}`, private: true, type: "module" })}\n`);
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  if (opts.init !== false) {
    ok(hunch(f, {}, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit"), "init");
    git(root, env, "add", "-A");
    git(root, env, "commit", "-qm", "chore: hunch init");
  }
  return f;
}

/** a.ts → b.ts → c.ts import chain. */
const CHAIN = {
  "src/a.ts": "import { b } from \"./b.js\";\nexport function a(): number { return b() + 1; }\n",
  "src/b.ts": "import { c } from \"./c.js\";\nexport function b(): number { return c() + 1; }\n",
  "src/c.ts": "export function c(): number { return 1; }\n",
};

function decision(id: string, title: string, over: Partial<Decision> = {}): Decision {
  return {
    id, title, topic: null, status: "accepted", context: "fixture", decision: `${title}.`,
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function finding(title: string, over: Partial<Finding> = {}): Finding {
  return {
    id: findingId(title), title, observation: "fixture observation", evidence: ["fixture evidence"], method: null,
    severity: "medium", triage: "open", affected_files: [], affected_symbols: [], violates_constraint: null,
    spawned_decision: null, observed_at: "2026-08-04T00:00:00.000Z", resolved_commit: null, provenance: prov(), ...over,
  };
}

function withStore(f: Fixture, run: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(f.root));
  try {
    store.json.ensureDirs();
    run(store);
  } finally {
    store.close();
  }
}

test("init --all-assistants configures undetected assistants; --details prints every step", () => {
  const f = makeRepo("init-assist", { init: false, files: { ".cursor/README.md": "cursor is here\n" } });
  try {
    const detected = ok(hunch(f, {}, "init", "--no-agent-hooks", "--no-auto-commit"), "init (Cursor detected)");
    assert.match(detected, /not found here, so not configured: .*Windsurf/);
    assert.match(detected, /More: hunch init --details/);
    assert.doesNotMatch(detected, /Cold start\? Seed from history/);
    assert.ok(!existsSync(join(f.root, ".windsurf")), "an undetected assistant gets no config");

    const all = ok(hunch(f, {}, "init", "--all-assistants", "--no-agent-hooks", "--no-auto-commit"), "init --all-assistants");
    assert.doesNotMatch(all, /not found here, so not configured/);
    assert.match(all, /assistants: .*Windsurf/);
    assert.ok(existsSync(join(f.root, ".windsurf")), "--all-assistants writes the undetected assistant's config");

    const details = ok(hunch(f, {}, "init", "--details", "--no-agent-hooks", "--no-auto-commit"), "init --details");
    assert.match(details, /🧠 Initializing Hunch at/);
    assert.match(details, /✓ \.hunch\/ scaffolded \(schema v/);
    assert.match(details, /Cold start\? Seed from history/);
    assert.doesNotMatch(details, /More: hunch init --details/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("init --private-sync and --shared-sync route the post-commit sync to the overlay", () => {
  const read = (f: Fixture) => readFileSync(join(f.root, ".git", "hooks", "post-commit"), "utf8");
  for (const flag of ["--private-sync", "--shared-sync"]) {
    const f = makeRepo(`init${flag}`, { init: false });
    try {
      ok(hunch(f, {}, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit"), "init");
      assert.doesNotMatch(read(f), /sync --from-hook --quiet --private/, "default hook syncs into the public store");
      const out = ok(hunch(f, {}, "init", flag, "--no-providers", "--no-agent-hooks", "--no-auto-commit", "--details"), `init ${flag}`);
      assert.match(out, /syncs to the shared overlay/);
      assert.match(read(f), /sync --from-hook --quiet --private/, `${flag} adds --private to the hook's sync`);
    } finally {
      cleanupDir(f.sandbox);
    }
  }
});

test("report --revision and --before page lesson history; report --public-only exports only public revisions", () => {
  const f = makeRepo("report");
  try {
    withStore(f, (s) => s.putCapture("decisions", decision("dec_fixture_rep001", "Keep package.json private", { related_files: ["package.json"] }), false));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "hunch: seed");
    refused(hunch(f, {}, "report", "--revision", `sha256:${"0".repeat(64)}`), /--kind, --revision and --before require --lesson/, "report --revision alone");
    refused(hunch(f, {}, "report", "--before", "5"), /--kind, --revision and --before require --lesson/, "report --before alone");
    refused(hunch(f, {}, "report", "--public-only"), /export requires an explicit task ID/, "report --public-only without a task");

    const task = JSON.parse(ok(hunch(f, {}, "task", "start", "Report flags fixture"), "task start")) as { task_id: string };
    ok(hunch(f, {}, "context", "package.json", "--task", task.task_id), "context --task");

    const lesson = (...extra: string[]) => JSON.parse(ok(hunch(f, {}, "report", "--lesson", "dec_fixture_rep001", "--kind", "decisions", ...extra), `report --lesson ${extra.join(" ")}`)) as { entries: Array<{ record: { content_hash: string } }> };
    const all = lesson();
    assert.ok(all.entries.length >= 1, "the context delivery is retained as a lesson appearance");
    const hash = all.entries[0]!.record.content_hash;
    assert.equal(lesson("--revision", hash).entries.length, all.entries.length, "--revision with the delivered hash keeps the appearance");
    assert.equal(lesson("--revision", `sha256:${"0".repeat(64)}`).entries.length, 0, "--revision with another hash filters it out");
    assert.equal(lesson("--before", "1").entries.length, 0, "--before 1 pages past every retained event");

    const plain = ok(hunch(f, {}, "report", task.task_id), "report <id>");
    assert.throws(() => JSON.parse(plain), "the default report is rendered text");
    const exported = JSON.parse(ok(hunch(f, {}, "report", task.task_id, "--public-only"), "report --public-only")) as { records: Array<{ record_id: string }> };
    assert.ok(Array.isArray(exported.records), "--public-only emits the public JSON export");
    assert.ok(exported.records.every((r) => r.record_id.startsWith("dec_fixture_rep001")), "only public records are exported");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("grounding --force is ignored without --refresh and accepted with it", () => {
  const f = makeRepo("grounding");
  try {
    const warned = hunch(f, {}, "grounding", "--force");
    assert.match(warned.out, /--force only applies with --refresh; checking without re-rendering/);
    const claude = join(f.root, "CLAUDE.md");
    assert.ok(existsSync(claude), "init wrote CLAUDE.md");
    ok(hunch(f, {}, "grounding", "--refresh", "--force"), "grounding --refresh --force");
    assert.match(readFileSync(claude, "utf8"), /HUNCH:START/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("shortlist --evidence validates the receipt before diagnosing; without it no optimization runs", () => {
  const f = makeRepo("shortlist", { files: CHAIN });
  try {
    const plain = ok(hunch(f, {}, "shortlist", "c returns the wrong number"), "shortlist");
    assert.match(plain, /Optimization: no verified evidence receipt supplied/);
    const bad = join(f.sandbox, "receipt.json");
    writeFileSync(bad, JSON.stringify({ version: 1 }));
    refused(hunch(f, {}, "shortlist", "c returns the wrong number", "--evidence", bad), /invalid verified-evidence receipt/, "shortlist --evidence with an invalid receipt");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("wiki --prose-heal needs the LLM and is skipped without a provider; wiki --private-prose lifts the private prose block", () => {
  const f = makeRepo("wiki", { files: CHAIN });
  try {
    ok(hunch(f, {}, "index"), "index");
    refused(hunch(f, {}, "wiki", "--prose-heal", "--no-llm"), /--prose-heal needs the LLM — drop --no-llm/, "wiki --prose-heal --no-llm");
    const plain = ok(hunch(f, {}, "wiki"), "wiki");
    assert.doesNotMatch(plain, /prose-heal skipped/);
    const healed = ok(hunch(f, {}, "wiki", "--prose-heal"), "wiki --prose-heal");
    assert.match(healed, /No LLM synthesis provider available — deterministic template pages \(prose-heal skipped\)/);

    const priv = { HUNCH_PRIVATE_DIR: join(f.sandbox, "overlay", ".hunch") };
    mkdirSync(priv.HUNCH_PRIVATE_DIR, { recursive: true });
    const blocked = ok(hunch(f, priv, "wiki", "--private"), "wiki --private");
    assert.match(blocked, /Private overlay: LLM prose is OFF/);
    const opted = ok(hunch(f, priv, "wiki", "--private", "--private-prose"), "wiki --private --private-prose");
    assert.doesNotMatch(opted, /Private overlay: LLM prose is OFF/);
    assert.match(opted, /No LLM synthesis provider available/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("findings --all includes resolved findings the default view hides", () => {
  const f = makeRepo("findings");
  try {
    withStore(f, (s) => {
      s.json.put("findings", finding("Open gap in fixture"));
      s.json.put("findings", finding("Closed gap in fixture", { triage: "resolved", resolved_commit: "abc1234" }));
    });
    const live = ok(hunch(f, {}, "findings"), "findings");
    assert.match(live, /Open gap in fixture/);
    assert.doesNotMatch(live, /Closed gap in fixture/);
    const all = ok(hunch(f, {}, "findings", "--all"), "findings --all");
    assert.match(all, /Closed gap in fixture/);
    assert.match(all, /\[resolved\//);
    assert.match(all, /2 finding\(s\)/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("path --max-depth bounds the hop search on an indexed three-file chain", () => {
  const f = makeRepo("path", { files: CHAIN });
  try {
    ok(hunch(f, {}, "index"), "index");
    const found = ok(hunch(f, {}, "path", "src/a.ts", "src/c.ts"), "path a → c");
    const hops = Number(/(\d+) hop\(s\):/.exec(found)?.[1]);
    assert.ok(hops >= 2, `a reaches c through b (got ${hops} hops)`);
    const bounded = hunch(f, {}, "path", "src/a.ts", "src/c.ts", "--max-depth", "1");
    assert.equal(bounded.status, 1, bounded.out);
    assert.match(bounded.out, /No path between "src\/a\.ts" and "src\/c\.ts" within 1 hop\(s\)/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("footprint --target measures hunch_context for the named file", () => {
  const f = makeRepo("footprint", { files: CHAIN });
  try {
    withStore(f, (s) => s.putCapture("decisions", decision("dec_fixture_fp0001", "Chain c stays pure", { related_files: ["src/c.ts"] }), false));
    const contextChars = (...extra: string[]) => {
      const out = ok(hunch(f, {}, "footprint", "--json", ...extra), `footprint ${extra.join(" ")}`);
      const report = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1)) as { surfaces: Array<{ id: string; detail?: { content_chars?: number } }> };
      return report.surfaces.find((s) => s.id === "mcp.hunch_context")!.detail!.content_chars!;
    };
    // Default target = the file most decisions cite; --target src/a.ts measures a
    // different file's brief, so the hunch_context surface changes size.
    const byDefault = contextChars();
    const targeted = contextChars("--target", "src/a.ts");
    assert.notEqual(targeted, byDefault, `--target src/a.ts must measure a different brief (${targeted} vs default ${byDefault})`);
    assert.equal(contextChars("--target", "src/a.ts"), targeted, "the targeted measurement is deterministic");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("impact --working covers unstaged edits that the staged default misses", () => {
  const f = makeRepo("impact", { files: CHAIN });
  try {
    ok(hunch(f, {}, "index"), "index");
    writeFileSync(join(f.root, "src", "c.ts"), "export function c(): number { return 2; }\n");
    assert.match(ok(hunch(f, {}, "impact"), "impact (staged)"), /No changed files in staged changes\./);
    const working = ok(hunch(f, {}, "impact", "--working"), "impact --working");
    assert.doesNotMatch(working, /No changed files/);
    assert.match(working, /working changes/);
    refused(hunch(f, {}, "impact", "--working", "--commit", "HEAD"), /Pass exactly one of/, "impact --working --commit");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("check --blast prints the dependency blast radius of the changed files", () => {
  const f = makeRepo("blast", { files: CHAIN });
  try {
    ok(hunch(f, {}, "index"), "index");
    writeFileSync(join(f.root, "src", "c.ts"), "export function c(): number { return 3; }\n");
    git(f.root, f.env, "add", "src/c.ts");
    const plain = ok(hunch(f, {}, "check"), "check");
    assert.doesNotMatch(plain, /Blast radius of/);
    const blast = ok(hunch(f, {}, "check", "--blast"), "check --blast");
    assert.match(blast, /Blast radius of 1 changed file\(s\):/);
    assert.match(blast, /src\/c\.ts → [1-9]\d* dependent file\(s\): .*src\/b\.ts/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("import-adr --private writes into the overlay and is refused without one", () => {
  const adr = "# 1. Use PostgreSQL\n\nDate: 2026-01-01\n\n## Status\n\nAccepted\n\n## Context\n\nWe need durable orders.\n\n## Decision\n\nUse PostgreSQL.\n\n## Consequences\n\nRun a database.\n";
  const f = makeRepo("adr", { files: { "docs/adr/0001-use-postgresql.md": adr } });
  try {
    const publicDecisions = () => readdirSync(join(f.root, ".hunch", "decisions")).filter((n) => n.endsWith(".json"));
    const before = publicDecisions().length;
    const noOverlay = hunch(f, {}, "import-adr", "--private");
    assert.notEqual(noOverlay.status, 0, `import-adr --private without an overlay must fail:\n${noOverlay.out}`);
    assert.match(noOverlay.out, /No private store configured|HUNCH_PRIVATE_DIR/);
    assert.equal(publicDecisions().length, before, "a refused private import writes nothing public");

    const overlay = join(f.sandbox, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    const out = ok(hunch(f, { HUNCH_PRIVATE_DIR: overlay }, "import-adr", "--private"), "import-adr --private");
    assert.match(out, /imported 1 ADR\(s\) .*\[private overlay\]/);
    assert.equal(publicDecisions().length, before, "the ADR never lands in the public store");
    assert.ok(readdirSync(join(overlay, "decisions")).some((n) => n.endsWith(".json")), "the ADR lands in the overlay");

    ok(hunch(f, {}, "import-adr"), "import-adr (public)");
    assert.equal(publicDecisions().length, before + 1, "without --private the ADR lands in the public store");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("runbook --semantic runs and degrades to keyword retrieval when no embedder is configured", () => {
  const f = makeRepo("runbook", { files: CHAIN });
  try {
    writeFileSync(join(f.root, "src", "c.ts"), "export function c(): number { return 4; }\n");
    git(f.root, f.env, "commit", "-qam", "bump c for the release");
    ok(hunch(f, {}, "runbook", "HEAD~1", "--task", "release the chain package"), "runbook capture");
    const keyword = ok(hunch(f, {}, "runbook", "--find", "release chain"), "runbook --find");
    assert.match(keyword, /Runbooks for "release chain"/);
    const semantic = ok(hunch(f, { HUNCH_EMBEDDER: "none" }, "runbook", "--find", "release chain", "--semantic"), "runbook --find --semantic");
    assert.equal(semantic, keyword, "with no embedder --semantic falls back to the same keyword hits");
  } finally {
    cleanupDir(f.sandbox);
  }
});
