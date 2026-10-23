import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir, writeLocalPointer } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { mapAdrCorpus } from "../src/extractors/adrImport.js";
import { importedAdrReview, importedAdrReviewHash, importedAdrSourceHash } from "../src/core/importReview.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";

/** Black-box coverage for high-consequence flags: `constitution g2 --allow-install-script`
 *  (lifecycle scripts are opt-in and only valid with a dependency action), `review
 *  --decline-import` (a hash-bound decline that must never grant authority), and
 *  `worktree --no-share` / `--branch`. Each runs on a temp repo after
 *  `hunch init --no-providers`; no model or network is reached. */

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string }

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function refused(r: Run, pattern: RegExp, what: string): void {
  assert.notEqual(r.status, 0, `${what} must exit non-zero:\n${r.out}`);
  assert.match(r.out, pattern, `${what} must explain the refusal`);
}

function makeRepo(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-flags-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "flags@example.com"], ["user.name", "Flags"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(root, env, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-flags-${label}`, private: true, type: "module" })}\n`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  const init = hunch(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  assert.equal(init.status, 0, `init failed:\n${init.out}`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  return f;
}

test("constitution g2 --allow-install-script is refused without a dependency action and writes nothing", () => {
  const f = makeRepo("g2");
  try {
    const before = git(f.root, f.env, "status", "--porcelain", "--untracked-files=all");
    refused(hunch(f, "constitution", "g2", "--allow-install-script", "esbuild"),
      /--allow-install-script requires --behavior-deps or --behavior-policy-materialize/, "--allow-install-script alone");
    refused(hunch(f, "constitution", "g2", "--behavior-materialize", "--allow-install-script", "esbuild"),
      /--allow-install-script requires --behavior-deps or --behavior-policy-materialize/, "--allow-install-script with an assessment-only action");
    refused(hunch(f, "constitution", "g2", "--behavior-deps", "cand_x", "--allow-install-script", "esbuild"),
      /--behavior-deps requires --behavior-review-hash/, "--behavior-deps without its review hash never reaches an install");
    assert.equal(git(f.root, f.env, "status", "--porcelain", "--untracked-files=all"), before, "refusals write nothing");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("review --decline-import records a hash-bound decline that stays advisory; a stale hash is refused", () => {
  const f = makeRepo("decline");
  try {
    const text = "---\nstatus: accepted\ndate: 2026-08-01\n---\n\n# Use PostgreSQL\n\n## Context\n\nOrders need durable storage.\n\n## Decision\n\nUse PostgreSQL for durable relational storage.\n";
    const decision = mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text }]).decisions[0]!;
    const store = new HunchStore(hunchPaths(f.root));
    store.json.ensureDirs();
    store.json.put("decisions", decision);
    store.close();
    const file = join(f.root, ".hunch", "decisions", `${decision.id}.json`);
    const original = readFileSync(file, "utf8");
    const sourceHash = importedAdrSourceHash(decision)!;
    const reviewHash = importedAdrReviewHash(decision);

    refused(hunch(f, "review", "--decline-import", decision.id, "--expected-source-hash", `sha256:${"0".repeat(64)}`, "--expected-review-hash", reviewHash, "--reviewed-by", "human:flags"),
      /hash|changed|mismatch|stale/i, "decline with a stale source hash");
    refused(hunch(f, "review", "--decline-import", decision.id, "--approve-import", decision.id, "--expected-source-hash", sourceHash, "--expected-review-hash", reviewHash, "--reviewed-by", "human:flags"),
      /choose exactly one review action/, "decline and approve together");
    assert.equal(readFileSync(file, "utf8"), original, "refused declines leave the decision untouched");

    const ok = hunch(f, "review", "--decline-import", decision.id, "--expected-source-hash", sourceHash, "--expected-review-hash", reviewHash, "--reviewed-by", "human:flags");
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /declined authority/);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Decision;
    assert.equal(importedAdrReview(stored)?.disposition, "decline");
    assert.doesNotMatch(stored.provenance.source, /human_confirmed/, "a decline never grants human-confirmed authority");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("worktree --no-share skips the shared overlay pointer that the default registers; --branch creates the named branch", () => {
  const f = makeRepo("worktree");
  try {
    const privateRoot = join(f.sandbox, "private");
    const privateDir = join(privateRoot, ".hunch");
    mkdirSync(privateDir, { recursive: true });
    git(privateRoot, f.env, "init", "-q", "-b", "main");
    writeLocalPointer(f.root, { privateDir, autoCommit: false, mode: "private" });
    // The fixture pre-registers the common-dir pointer (as `hunch private` does), so
    // --no-share is observable as: no registration attempted, pointer bytes untouched.
    const pointer = join(f.root, ".git", "hunch", "local.json");
    const registered = readFileSync(pointer, "utf8");

    const noShare = hunch(f, "worktree", join(f.sandbox, "wt-noshare"), "--no-share", "--no-index", "--branch", "flags/no-share");
    assert.equal(noShare.status, 0, noShare.out);
    assert.match(noShare.out, /--no-share — the worktree will NOT see private memory/);
    assert.doesNotMatch(noShare.out, /memory shared via the git common dir/, "--no-share registers no overlay");
    assert.equal(readFileSync(pointer, "utf8"), registered, "--no-share leaves the common-dir pointer untouched");
    assert.equal(git(join(f.sandbox, "wt-noshare"), f.env, "branch", "--show-current"), "flags/no-share", "--branch names the new branch");

    const shared = hunch(f, "worktree", join(f.sandbox, "wt-shared"), "--no-index");
    assert.equal(shared.status, 0, shared.out);
    assert.match(shared.out, /memory shared via the git common dir/);
    assert.ok(existsSync(pointer), "the default registers the overlay at the git common dir");
  } finally {
    cleanupDir(f.sandbox);
  }
});
