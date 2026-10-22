/**
 * Issue #482: a failed team-memory pull must say WHICH step failed and why, and its
 * git budgets must be widenable on slow runners via HUNCH_PULL_GIT_TIMEOUT_MS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_READ_REMOTE_TIMEOUT_MS, describePullFailure, pullGitTimeoutOverride, pullHunchStatus, pullHunchStatusDetailed, pullLocalGitTimeoutMs, pullRemoteTimeoutMs, redactUrlUserinfo } from "../src/extractors/git.js";
import { cleanupDir } from "./helpers.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

function withEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env.HUNCH_PULL_GIT_TIMEOUT_MS;
  if (value === undefined) delete process.env.HUNCH_PULL_GIT_TIMEOUT_MS;
  else process.env.HUNCH_PULL_GIT_TIMEOUT_MS = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.HUNCH_PULL_GIT_TIMEOUT_MS;
    else process.env.HUNCH_PULL_GIT_TIMEOUT_MS = saved;
  }
}

test("HUNCH_PULL_GIT_TIMEOUT_MS: positive integers only; local budgets scale to max(2s, value/2.5)", () => {
  withEnv(undefined, () => { assert.equal(pullGitTimeoutOverride(), undefined); assert.equal(pullLocalGitTimeoutMs(), 2_000); });
  for (const bad of ["", "  ", "0", "-5", "1.5", "abc", "20s", "1e4"]) {
    withEnv(bad, () => { assert.equal(pullGitTimeoutOverride(), undefined, bad); assert.equal(pullLocalGitTimeoutMs(), 2_000, bad); });
  }
  withEnv(" 20000 ", () => { assert.equal(pullGitTimeoutOverride(), 20_000); assert.equal(pullLocalGitTimeoutMs(), 8_000); });
  withEnv("3000", () => { assert.equal(pullGitTimeoutOverride(), 3_000); assert.equal(pullLocalGitTimeoutMs(), 2_000); });
  withEnv("99999999", () => assert.equal(pullGitTimeoutOverride(), 600_000));
});

test("a pull against a vanished remote fails with the failing step and git's stderr", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-pull-detail-"));
  try {
    const remote = join(base, "remote.git");
    g(base, "init", "--bare", "-b", "main", remote);
    const A = join(base, "A");
    mkdirSync(join(A, ".hunch", "decisions"), { recursive: true });
    g(A, "init", "-b", "main", ".");
    g(A, "config", "user.email", "t@example.com"); g(A, "config", "user.name", "T");
    writeFileSync(join(A, ".hunch", "manifest.json"), '{"schema_version":1}\n');
    g(A, "add", "-A"); g(A, "commit", "-q", "-m", "seed");
    g(A, "remote", "add", "origin", remote); g(A, "push", "-q", "-u", "origin", "main");
    renameSync(remote, join(base, "gone.git"));

    const result = pullHunchStatusDetailed(join(A, ".hunch"));
    assert.equal(result.status, "failed");
    assert.equal(result.detail?.step, "fetch");
    assert.ok(result.detail?.stderr && result.detail.stderr.length > 0, "git's stderr is captured");
    assert.ok(result.detail!.stderr!.length <= 400);
    assert.match(result.detail?.code ?? "", /^exit \d+$/);
    assert.equal(pullHunchStatus(join(A, ".hunch")), "failed", "the plain status API is unchanged");

    const line = describePullFailure(result.detail);
    assert.match(line, /^step: fetch, exit \d+, \S/);
    // The CLI strict-check refusal appends exactly this rendering.
    const refusal = `strict check could not refresh the advertised team memory (failed); refusing a stale pass (${line})`;
    assert.match(refusal, /\(step: fetch,/);
  } finally {
    cleanupDir(base);
  }
});

test("describePullFailure renders step-only details and nothing for no detail", () => {
  assert.equal(describePullFailure(undefined), "");
  assert.equal(describePullFailure({ step: "worktree-clean" }), "step: worktree-clean");
  assert.equal(describePullFailure({ step: "ls-remote", code: "ETIMEDOUT", stderr: "\n fatal: x \nsecond" }), "step: ls-remote, ETIMEDOUT, fatal: x");
});

test("an explicit caller budget always beats HUNCH_PULL_GIT_TIMEOUT_MS; the env only replaces the default", () => {
  withEnv(undefined, () => { assert.equal(pullRemoteTimeoutMs(), DEFAULT_READ_REMOTE_TIMEOUT_MS); assert.equal(pullRemoteTimeoutMs(300), 300); });
  withEnv("20000", () => { assert.equal(pullRemoteTimeoutMs(), 20_000); assert.equal(pullRemoteTimeoutMs(300), 300); });
  withEnv("junk", () => assert.equal(pullRemoteTimeoutMs(), DEFAULT_READ_REMOTE_TIMEOUT_MS));
});

test("captured stderr never keeps URL credentials", () => {
  assert.equal(redactUrlUserinfo("fatal: unable to access 'https://user:s3cret@github.com/o/r.git/': 403"), "fatal: unable to access 'https://***@github.com/o/r.git/': 403");
  assert.equal(redactUrlUserinfo("remote: https://ghp_TOKEN123@host/x and ssh://git@host:22/y"), "remote: https://***@host/x and ssh://***@host:22/y");
  assert.equal(redactUrlUserinfo("fatal: '/tmp/gone.git' does not appear to be a git repository"), "fatal: '/tmp/gone.git' does not appear to be a git repository");
});
