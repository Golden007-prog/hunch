import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";

/** Black-box coverage for flags the options gate (test/cli-options-surface.test.ts) found
 *  only mentioned, never passed: veto --staged/--commit/--format, record-bug/runbook --private,
 *  wiki --heal, constitution g2 --strict, landscape review --ref and sync --commit. Each runs on a temp repo after
 *  `hunch init --no-providers`; no model or network is reached. */

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string }

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function makeRepo(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-gaps-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, env };
  git(f, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "gaps@example.com"], ["user.name", "Gaps"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(f, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-gaps-${label}`, private: true, type: "module" })}\n`);
  git(f, "add", "-A");
  git(f, "commit", "-qm", "fixture");
  const init = hunch(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  assert.equal(init.status, 0, init.out);
  git(f, "add", "-A");
  git(f, "commit", "-qm", "chore: hunch init");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  git(f, "add", "-A");
  git(f, "commit", "-qm", "feat: add module a with a real change");
  return f;
}

test("veto --staged, --commit and --format each check their own file set and keep a clean verdict at exit 0", () => {
  const f = makeRepo("veto");
  try {
    writeFileSync(join(f.root, "src/b.ts"), "export const b = 2;\n");
    git(f, "add", "src/b.ts");
    const staged = hunch(f, "veto", "--staged");
    assert.equal(staged.status, 0, staged.out);
    assert.match(staged.out, /1 changed file\(s\) reverse no decision/);
    const commit = hunch(f, "veto", "--commit", "HEAD");
    assert.equal(commit.status, 0, commit.out);
    assert.match(commit.out, /1 changed file\(s\) reverse no decision/);
    const markdown = hunch(f, "veto", "--commit", "HEAD", "--format", "markdown");
    assert.equal(markdown.status, 0, markdown.out);
    assert.match(markdown.out, /reverse no decision/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("record-bug --private and runbook --private are refused without a private store and write nothing", () => {
  const f = makeRepo("private");
  try {
    const before = git(f, "status", "--porcelain", "--untracked-files=all");
    const bug = hunch(f, "record-bug", "--test", "t1", "--message", "boom", "--private");
    assert.notEqual(bug.status, 0, bug.out);
    assert.match(bug.out, /--private needs HUNCH_PRIVATE_DIR/);
    const runbook = hunch(f, "runbook", "HEAD~1..HEAD", "--task", "gaps", "--private");
    assert.notEqual(runbook.status, 0, runbook.out);
    assert.match(runbook.out, /--private needs HUNCH_PRIVATE_DIR/);
    assert.equal(git(f, "status", "--porcelain", "--untracked-files=all"), before, "refusals write nothing");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("wiki --heal writes the missing pages; constitution g2 --strict fails while the packet is not ready", () => {
  const f = makeRepo("wiki-g2");
  try {
    const heal = hunch(f, "wiki", "--heal");
    assert.equal(heal.status, 0, heal.out);
    assert.match(heal.out, /wiki\/README\.md \(new\)/);
    assert.match(heal.out, /page\(s\) written/);
    const plain = hunch(f, "constitution", "g2");
    assert.equal(plain.status, 0, plain.out);
    const strict = hunch(f, "constitution", "g2", "--strict");
    assert.equal(strict.status, 1, strict.out);
    assert.match(strict.out, /"g2_passed": false/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("landscape review --ref inspects the named commit, not HEAD, and refuses a ref that is not a commit", () => {
  const f = makeRepo("landscape");
  try {
    const parent = git(f, "rev-parse", "HEAD~1");
    const head = git(f, "rev-parse", "HEAD");
    const before = git(f, "status", "--porcelain", "--untracked-files=all");
    const atParent = hunch(f, "landscape", "review", "--ref", "HEAD~1", "--json");
    assert.equal(atParent.status, 0, atParent.out);
    assert.match(atParent.out, new RegExp(`"sourceRevision": "${parent}"`));
    assert.doesNotMatch(atParent.out, new RegExp(head));
    const human = hunch(f, "landscape", "review", "--ref", "HEAD~1");
    assert.equal(human.status, 0, human.out);
    assert.match(human.out, new RegExp(`Landscape candidates at ${parent}`));
    const bogus = hunch(f, "landscape", "review", "--ref", "no-such-ref");
    assert.notEqual(bogus.status, 0, bogus.out);
    assert.equal(git(f, "status", "--porcelain", "--untracked-files=all"), before, "review writes nothing");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("sync --commit commits the captured decision into the repo", () => {
  const f = makeRepo("sync");
  try {
    const head = git(f, "rev-parse", "HEAD");
    const synced = hunch(f, "sync", "HEAD", "--force", "--commit");
    assert.equal(synced.status, 0, synced.out);
    assert.notEqual(git(f, "rev-parse", "HEAD"), head, `--commit must add a commit:\n${synced.out}`);
    assert.doesNotMatch(git(f, "status", "--porcelain", "--", ".hunch/decisions"), /\S/, "captured decision is committed");
  } finally {
    cleanupDir(f.sandbox);
  }
});
