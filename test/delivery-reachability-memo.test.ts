import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDir } from "./fixtures.js";
import {
  commitReachabilityProbeCount,
  localCommitReachability,
  resetCommitReachabilityMemo,
} from "../src/core/delivery.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

test("delivery reachability: verdicts are memoized across delivery builds and follow the branch tip (#473)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-memo-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const c1 = commit(root, "c1");
    const c2 = commit(root, "c2");
    git(root, "checkout", "-qb", "feature");
    const f1 = commit(root, "f1");
    git(root, "checkout", "-q", "main");

    resetCommitReachabilityMemo();
    const commits = [c1.slice(0, 7), c2, f1, "deadbeefdeadbeef"];
    const before = commitReachabilityProbeCount();
    const first = commits.map(localCommitReachability(root));
    const afterFirst = commitReachabilityProbeCount();
    assert.deepEqual(first, ["reachable", "reachable", "unreachable", "unreachable"]);
    assert.ok(afterFirst - before > commits.length, "first build probes git per commit");

    // A second delivery build re-resolves only the branch tip; every verdict is memoized.
    const second = commits.map(localCommitReachability(root));
    assert.deepEqual(second, first);
    assert.equal(commitReachabilityProbeCount() - afterFirst, 1);

    // The tip moves: the feature commit becomes reachable and a new commit is judged fresh.
    git(root, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const c3 = commit(root, "c3");
    const third = [...commits, c3].map(localCommitReachability(root));
    assert.deepEqual(third, ["reachable", "reachable", "reachable", "unreachable", "reachable"]);
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: unknown verdicts outside a git repo are never memoized", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-nogit-"));
  try {
    resetCommitReachabilityMemo();
    assert.equal(localCommitReachability(root)("abcdef1"), "unknown");
    const before = commitReachabilityProbeCount();
    assert.equal(localCommitReachability(root)("abcdef1"), "unknown");
    assert.ok(commitReachabilityProbeCount() > before, "a later build probes git again");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});
