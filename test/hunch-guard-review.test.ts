import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateReview, reportHash } from "../tooling/hunch-guard-review.mjs";

const head = "0123456789abcdef0123456789abcdef01234567";
const base = "fedcba9876543210fedcba9876543210fedcba98";
const runId = 741852;

const policy = {
  schema: "hunch.guard-review-policy/1",
  default_branch: "main",
  maintainers: [{ id: 26892525, login: "davesheffer" }],
  evaluator: { package: "@davesheffer/hunch", version: "1.32.4" },
};

const pr = {
  number: 42,
  state: "open",
  head: { sha: head, repo: { full_name: "davesheffer/hunch" } },
  base: { ref: "main", sha: base, repo: { full_name: "davesheffer/hunch" } },
};

const actor = { id: 26892525, login: "davesheffer", type: "User" };
const run = { id: runId, event: "pull_request_target", head_sha: base, path: ".github/workflows/hunch-guard.yml", status: "completed", conclusion: "failure" };

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    schema: "hunch.guard-report/1",
    pr_number: 42,
    head_sha: head,
    base_sha: base,
    verdict: "failure",
    reviewable: true,
    evaluation_complete: true,
    failure_classes: ["direct_scope_blocker"],
    evaluator: { package: "@davesheffer/hunch", version: "1.32.4" },
    source: {
      run_id: runId,
      workflow_path: ".github/workflows/hunch-guard.yml",
      workflow_sha: base,
      event: "pull_request_target",
    },
    ...overrides,
  };
}

function request(report: object, overrides: Record<string, unknown> = {}) {
  return {
    pr_number: 42,
    head_sha: head,
    base_sha: base,
    report_hash: reportHash(report),
    reason: "The direct scope record is stale and the reviewed change fixes it.",
    authorize_exception: true,
    ...overrides,
  };
}

function review(overrides: { request?: Record<string, unknown>; pr?: object; actor?: object; report?: object; run?: object } = {}) {
  const report = overrides.report ?? fixture();
  return evaluateReview({
    policy,
    request: request(report, overrides.request),
    pr: overrides.pr ?? pr,
    actor: overrides.actor ?? actor,
    report,
    run: overrides.run ?? run,
  });
}

test("accepts a direct-scope exception only with exact maintainer and revision receipts", () => {
  const receipt = review();
  assert.equal(receipt.decision, "authorized_exception");
  assert.equal(receipt.head_sha, head);
  assert.equal(receipt.base_sha, base);
  assert.equal(receipt.source_run_id, runId);
});

for (const [label, actorOverride] of [
  ["wrong numeric id", { id: 26892526, login: "davesheffer", type: "User" }],
  ["renamed login", { id: 26892525, login: "other-login", type: "User" }],
  ["bot", { id: 26892525, login: "davesheffer", type: "Bot" }],
] as const) {
  test(`rejects ${label}`, () => assert.throws(() => review({ actor: actorOverride }), /refused|review actor/));
}

for (const [label, requestOverride] of [
  ["stale head", { head_sha: base }],
  ["stale base", { base_sha: head }],
  ["missing explicit authorization", { authorize_exception: false }],
  ["short reason", { reason: "because" }],
] as const) {
  test(`rejects ${label}`, () => assert.throws(() => review({ request: requestOverride }), /invalid|authorization|reason|changed/));
}

test("rejects a PR whose base is not the protected default branch", () => {
  assert.throws(() => review({ pr: { ...pr, base: { ...pr.base, ref: "release" } } }), /default branch/);
});

test("rejects a report hash changed after the request was prepared", () => {
  assert.throws(() => review({ request: { report_hash: "sha256:" + "0".repeat(64) } }), /hash/);
});

test("rejects a report that does not prove the full evaluation completed", () => {
  const report = fixture({ evaluation_complete: false });
  assert.throws(() => review({ report }), /reviewable failure/);
});

for (const failure of ["policy_failure", "executable_policy_failure", "conformance_failure", "veto", "regression", "unknown", "incomplete_evaluation", "infrastructure_failure"]) {
  test(`never waives ${failure}`, () => {
    const report = fixture({ failure_classes: [failure] });
    assert.throws(() => review({ report }), /non-waivable|unrecognized/);
  });
}

test("rejects a report produced by the existing untrusted pull_request run", () => {
  const report = fixture({ source: { ...fixture().source, event: "pull_request" } });
  assert.throws(() => review({ report, run: { ...run, event: "pull_request" } }), /trusted base context/);
});

test("rejects a report from a different workflow revision or run", () => {
  const report = fixture({ source: { ...fixture().source, workflow_sha: head } });
  assert.throws(() => review({ report }), /trusted base workflow run/);
  assert.throws(() => review({ report: fixture({ source: { ...fixture().source, run_id: runId + 1 } }) }), /trusted base workflow run/);
});

test("review workflow remains data-only and separate from the required guard", () => {
  const workflow = readFileSync(new URL("../.github/workflows/hunch-guard-review.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /context="hunch-guard-review"/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /npm (?:install|run)/);
  assert.doesNotMatch(workflow, /\bhunch check\b/);
  assert.doesNotMatch(workflow, /checkout[^\n]*head\.sha/);
});
