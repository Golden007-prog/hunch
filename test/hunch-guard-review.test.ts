import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateReview, reportHash, validateArtifactMetadata } from "../tooling/hunch-guard-review.mjs";
import { activeExecutablePolicy, classifySarif, workflowRunMeta } from "../tooling/hunch-guard-review-producer.mjs";

const head = "0123456789abcdef0123456789abcdef01234567";
const base = "fedcba9876543210fedcba9876543210fedcba98";
const trusted = "89abcdef0123456789abcdef0123456789abcdef";
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
const run = { id: runId, event: "workflow_run", head_sha: trusted, head_branch: "main", path: ".github/workflows/hunch-guard-review-producer.yml", status: "completed", conclusion: "success" };

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
    findings: [{ rule_id: "con_scope", level: "error", message: "direct invariant", file: "src/example.ts" }],
    evaluator: { package: "@davesheffer/hunch", version: "1.32.4" },
    source: {
      run_id: runId,
      workflow_path: ".github/workflows/hunch-guard-review-producer.yml",
      workflow_sha: trusted,
      event: "workflow_run",
      trigger_head_sha: head,
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
  assert.throws(() => review({ report, run: { ...run, event: "pull_request" } }), /trusted base context|trusted base workflow run/);
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

test("producer is default-branch workflow_run code and never installs or runs PR code", () => {
  const workflow = readFileSync(new URL("../.github/workflows/hunch-guard-review-producer.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["Hunch Guard"\]/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /node tooling\/hunch-guard-review-producer\.mjs/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /npm install/);
  assert.doesNotMatch(workflow, /actions\/checkout[^\n]*head_sha/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.number/);
});

test("producer binds the workflow_run event shape to one exact PR head", () => {
  const event = { workflow_run: { event: "pull_request", pull_requests: [{ number: 42, head: { sha: head } }] } };
  assert.deepEqual(workflowRunMeta(event), { pr_number: 42, trigger_head_sha: head });
  assert.throws(() => workflowRunMeta({ workflow_run: { event: "pull_request", pull_requests: [] } }), /exactly one/);
  assert.throws(() => workflowRunMeta({ workflow_run: { event: "pull_request", pull_requests: [{ number: 42, head: { sha: base } }, { number: 43, head: { sha: head } }] } }), /exactly one/);
});

test("producer's extracted version command accepts a normal release version", () => {
  const workflow = readFileSync(new URL("../.github/workflows/hunch-guard-review-producer.yml", import.meta.url), "utf8");
  const command = workflow.match(/version=\"\$\(node --input-type=module -e '([^']+)'\)\"/)?.[1];
  assert.ok(command, "trusted version command must remain present");
  const dir = mkdtempSync(join(tmpdir(), "hunch-guard-version-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.32.5" }));
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", command!], { cwd: dir, encoding: "utf8" }), "1.32.5");
});

test("artifact metadata is exact, bounded, unexpired, and tied to the requested run", () => {
  const payload = { artifacts: [{ id: 99, name: "hunch-guard-report", expired: false, size_in_bytes: 512, workflow_run: { id: runId } }] };
  assert.equal(validateArtifactMetadata(payload, runId), 99);
  for (const bad of [
    { ...payload, artifacts: [{ ...payload.artifacts[0], size_in_bytes: 1024 * 1024 + 1 }] },
    { ...payload, artifacts: [{ ...payload.artifacts[0], expired: true }] },
    { ...payload, artifacts: [{ ...payload.artifacts[0], workflow_run: { id: runId + 1 } }] },
    { ...payload, artifacts: [] },
  ]) assert.throws(() => validateArtifactMetadata(bad, runId), /artifact/);
});

test("producer classifies only a lone direct constraint error as reviewable", () => {
  const sarif = (results: object[]) => ({ version: "2.1.0", runs: [{ results }] });
  const direct = classifySarif(sarif([{ level: "error", ruleId: "con_scope", message: { text: "direct" } }]), 1);
  assert.deepEqual(direct, { verdict: "failure", reviewable: true, evaluation_complete: true, failure_classes: ["direct_scope_blocker"], findings: [{ rule_id: "con_scope", level: "error", message: "direct" }] });
  assert.equal(classifySarif(sarif([{ level: "error", ruleId: "con_scope", message: { text: "direct" } }]), 1, "strict freshness error").reviewable, false);
  for (const [ruleId, text] of [["pol_policy", "policy error"], ["dec_conf", "architectural conformance violated: x"], ["dec_veto", "reverses rejected approach"], ["dec_reg", "re-adds function"]]) {
    const result = classifySarif(sarif([{ level: "error", ruleId, message: { text } }]), 1);
    assert.equal(result.reviewable, false);
    assert.equal(result.verdict, "failure");
  }
  assert.equal(classifySarif(null, null).evaluation_complete, false);
});

test("producer treats a missing policy directory as no policies, while malformed policy data fails closed", () => {
  const empty = mkdtempSync(join(tmpdir(), "hunch-guard-empty-policy-"));
  assert.equal(activeExecutablePolicy(empty), false);
  const malformed = mkdtempSync(join(tmpdir(), "hunch-guard-malformed-policy-"));
  mkdirSync(join(malformed, ".hunch", "policies"), { recursive: true });
  writeFileSync(join(malformed, ".hunch", "policies", "bad.json"), "not json");
  assert.equal(activeExecutablePolicy(malformed), true);
});
