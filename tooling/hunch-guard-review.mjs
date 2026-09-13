import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const REPORT_HASH = /^sha256:[0-9a-f]{64}$/;
const SCHEMA = "hunch.guard-review-policy/1";
const REPORT_SCHEMA = "hunch.guard-report/1";
const TRUSTED_GUARD_PATH = ".github/workflows/hunch-guard-review-producer.yml";
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVIEWABLE_FAILURES = new Set(["direct_scope_blocker"]);
const NEVER_WAIVE = new Set([
  "policy_failure",
  "stale_base",
  "executable_policy_failure",
  "conformance_failure",
  "veto",
  "regression",
  "unknown",
  "incomplete_evaluation",
  "infrastructure_failure",
]);

function fail(message) {
  const error = new Error(message);
  error.code = "GUARD_REVIEW_REFUSED";
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  fail("report contains a non-JSON value");
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function reportHash(report) {
  return `sha256:${createHash("sha256").update(canonicalJson(report)).digest("hex")}`;
}

export function validateArtifactMetadata(payload, runId, name = "hunch-guard-report") {
  if (!isObject(payload) || !Array.isArray(payload.artifacts)) fail("artifact metadata is invalid");
  const matches = payload.artifacts.filter((artifact) => isObject(artifact) && artifact.name === name);
  if (matches.length !== 1) fail(`expected exactly one ${name} artifact`);
  const artifact = matches[0];
  requiredInteger(artifact.id, "artifact.id");
  requiredInteger(runId, "artifact run id");
  if (artifact.expired === true || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
    fail("guard artifact is expired or exceeds the 1 MiB limit");
  }
  if (!isObject(artifact.workflow_run) || artifact.workflow_run.id !== runId) fail("guard artifact is not bound to the requested run");
  return artifact.id;
}

function requiredString(value, label, pattern = null) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
  return value;
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
}

function validatePolicy(policy) {
  if (!isObject(policy) || policy.schema !== SCHEMA) fail("unsupported guard review policy schema");
  requiredString(policy.default_branch, "policy.default_branch");
  if (!Array.isArray(policy.maintainers) || policy.maintainers.length === 0) fail("policy has no maintainers");
  for (const maintainer of policy.maintainers) {
    if (!isObject(maintainer)) fail("policy maintainer is invalid");
    requiredInteger(maintainer.id, "policy maintainer.id");
    requiredString(maintainer.login, "policy maintainer.login");
  }
  if (!isObject(policy.evaluator)) fail("policy evaluator is missing");
  requiredString(policy.evaluator.package, "policy evaluator.package");
  if (policy.evaluator.version_source !== "trusted-package-json") fail("policy evaluator version must come from the trusted package manifest");
}

function validateRequest(request) {
  if (!isObject(request)) fail("review request is missing");
  requiredInteger(request.pr_number, "request.pr_number");
  requiredString(request.head_sha, "request.head_sha", SHA);
  requiredString(request.base_sha, "request.base_sha", SHA);
  requiredString(request.report_hash, "request.report_hash", REPORT_HASH);
  if (request.authorize_exception !== true) fail("explicit exception authorization is required");
  if (typeof request.reason !== "string" || request.reason.trim().length < 10 || request.reason.length > 1000) {
    fail("review reason must be between 10 and 1000 characters");
  }
}

function validatePr(pr, policy, request) {
  if (!isObject(pr) || pr.number !== request.pr_number || pr.state !== "open") fail("PR is not the requested open PR");
  if (!isObject(pr.head) || pr.head.sha !== request.head_sha) fail("PR head changed or does not match the request");
  if (!isObject(pr.base) || pr.base.sha !== request.base_sha || pr.base.ref !== policy.default_branch) {
    fail("PR base changed or is not the protected default branch");
  }
  if (!isObject(pr.base.repo) || !isObject(pr.head.repo) || pr.base.repo.full_name !== pr.head.repo.full_name) {
    fail("PR repository does not match the trusted repository");
  }
}

function validateActor(actor, policy) {
  if (!isObject(actor) || actor.type !== "User") fail("review actor is not a human user");
  const id = requiredInteger(actor.id, "review actor.id");
  const login = requiredString(actor.login, "review actor.login");
  const allowed = policy.maintainers.find((entry) => entry.id === id && entry.login === login);
  if (!allowed) fail("review actor is not an authorized maintainer");
}

function validateReport(report, policy, request, run, evaluatorVersion) {
  if (!isObject(report) || report.schema !== REPORT_SCHEMA) fail("unsupported guard report schema");
  if (report.pr_number !== request.pr_number || report.head_sha !== request.head_sha || report.base_sha !== request.base_sha) {
    fail("guard report is for a different PR revision");
  }
  if (report.verdict !== "failure" || report.reviewable !== true || report.evaluation_complete !== true || !Array.isArray(report.failure_classes)) {
    fail("guard report is not an explicit reviewable failure");
  }
  if (!Array.isArray(report.findings) || report.findings.length === 0 || report.findings.length > 64) fail("guard report finding evidence is missing or too large");
  for (const finding of report.findings) {
    if (!isObject(finding) || typeof finding.rule_id !== "string" || finding.rule_id.length < 1 || finding.rule_id.length > 200 || typeof finding.level !== "string" || typeof finding.message !== "string" || finding.message.length > 4096) fail("guard report finding evidence is invalid");
  }
  const classes = new Set(report.failure_classes);
  if (classes.size !== report.failure_classes.length || classes.size === 0) fail("guard report failure classes are invalid");
  for (const failure of classes) {
    if (NEVER_WAIVE.has(failure)) fail(`guard report contains a non-waivable ${failure}`);
    if (!REVIEWABLE_FAILURES.has(failure)) fail(`guard report contains an unrecognized failure class: ${failure}`);
  }
  if (!isObject(report.evaluator)) fail("guard report evaluator receipt is missing");
  if (report.evaluator.package !== policy.evaluator.package || report.evaluator.version !== evaluatorVersion) {
    fail("guard report used an unapproved evaluator");
  }
  if (!isObject(report.source)) fail("guard report source receipt is missing");
  const source = report.source;
  requiredInteger(source.run_id, "guard report source.run_id");
  requiredString(source.workflow_path, "guard report source.workflow_path");
  requiredString(source.workflow_sha, "guard report source.workflow_sha", SHA);
  requiredString(source.trigger_head_sha, "guard report source.trigger_head_sha", SHA);
  if (source.run_id !== run.id || source.workflow_path !== run.path || source.workflow_path !== TRUSTED_GUARD_PATH || source.workflow_sha !== run.head_sha || source.trigger_head_sha !== request.head_sha) {
    fail("guard report source is not bound to the trusted base workflow run");
  }
  if (run.event !== "workflow_run" || run.status !== "completed" || run.conclusion !== "success" || run.head_branch !== policy.default_branch || run.head_sha !== source.workflow_sha) {
    fail("guard report run was not produced in trusted base context");
  }
  if (source.event !== run.event) fail("guard report event receipt does not match the run");
  if (classes.has("direct_scope_blocker") && !report.findings.some((finding) => finding.rule_id.startsWith("con_") && finding.level === "error")) fail("direct scope report has no cited blocking invariant");
}

export function evaluateReview({ policy, request, pr, actor, report, run, evaluatorVersion }) {
  validatePolicy(policy);
  validateRequest(request);
  requiredString(evaluatorVersion, "trusted evaluator version", VERSION);
  validateActor(actor, policy);
  validatePr(pr, policy, request);
  if (!isObject(run)) fail("guard run metadata is missing");
  const runId = requiredInteger(run.id, "guard run.id");
  requiredString(run.path, "guard run.path");
  requiredString(run.head_sha, "guard run.head_sha", SHA);
  requiredString(run.event, "guard run.event");
  if (reportHash(report) !== request.report_hash) fail("guard report hash does not match the request");
  validateReport(report, policy, request, { ...run, id: runId }, evaluatorVersion);
  return {
    schema: "hunch.guard-review-receipt/1",
    decision: "authorized_exception",
    pr_number: request.pr_number,
    head_sha: request.head_sha,
    base_sha: request.base_sha,
    report_hash: request.report_hash,
    actor: { id: actor.id, login: actor.login },
    reason: request.reason.trim(),
    source_run_id: runId,
    failure_classes: [...report.failure_classes],
    findings: report.findings,
  };
}

function readJson(path, label) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} is not a regular file`);
    if (stat.size > 1024 * 1024) fail(`${label} exceeds the 1 MiB receipt limit`);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label}: ${error.message}`);
  }
}

function argument(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) fail(`missing ${name}`);
  return args[index + 1];
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== "--verify") fail("usage: hunch-guard-review.mjs --verify --policy FILE --request FILE --pr FILE --actor FILE --report FILE --run FILE --evaluator-version VERSION [--output FILE]");
    const receipt = evaluateReview({
      policy: readJson(argument(args, "--policy"), "policy"),
      request: readJson(argument(args, "--request"), "request"),
      pr: readJson(argument(args, "--pr"), "PR"),
      actor: readJson(argument(args, "--actor"), "actor"),
      report: readJson(argument(args, "--report"), "report"),
      run: readJson(argument(args, "--run"), "guard run"),
      evaluatorVersion: argument(args, "--evaluator-version"),
    });
    const output = args.includes("--output") ? argument(args, "--output") : null;
    if (output) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`Hunch guard review refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
