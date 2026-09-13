import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const REVIEWABLE = "direct_scope_blocker";
const MAX_SARIF_BYTES = 2 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function required(value, label) { if (typeof value !== "string" || !value) fail(`${label} is missing`); return value; }
function sha(value, label) { required(value, label); if (!SHA.test(value)) fail(`${label} is not a full SHA`); return value; }

export function workflowRunMeta(event) {
  const run = event?.workflow_run;
  const pullRequests = run?.pull_requests;
  if (!run || run.event !== "pull_request" || !Array.isArray(pullRequests) || pullRequests.length !== 1) fail("workflow_run is not bound to exactly one pull request");
  const pull = pullRequests[0];
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || !SHA.test(pull.head?.sha ?? "")) fail("workflow_run pull request has no full head binding");
  return { pr_number: pull.number, trigger_head_sha: pull.head.sha };
}

function git(repo, args, env) {
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function archive(repo, revision, destination, pathspec = null, env) {
  mkdirSync(destination, { recursive: true });
  const args = ["-C", repo, "archive", "--format=tar", revision];
  if (pathspec) args.push("--", pathspec);
  const bytes = execFileSync("git", args, { env, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: bytes, env, stdio: ["pipe", "ignore", "pipe"] });
}

function emptyTree(destination) {
  for (const entry of readdirSync(destination)) {
    if (entry !== ".git") rmSync(join(destination, entry), { recursive: true, force: true });
  }
}

function commit(repo, message, env) {
  git(repo, ["add", "--all"], env);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", message], env);
  return git(repo, ["rev-parse", "HEAD"], env);
}

function buildSyntheticRepo(repo, baseSha, headSha, temp, env) {
  const checkout = join(temp, "candidate-data");
  mkdirSync(checkout, { recursive: true });
  git(temp, ["init", "--quiet", checkout], env);
  git(checkout, ["config", "core.hooksPath", "/dev/null"], env);
  git(checkout, ["config", "user.name", "Hunch Guard Producer"], env);
  git(checkout, ["config", "user.email", "guard-producer@invalid"], env);

  // Git archive copies tree bytes only. It does not checkout attributes, invoke
  // hooks, initialize submodules, or execute anything from the PR.
  archive(repo, baseSha, checkout, null, env);
  const syntheticBase = commit(checkout, "trusted guard base", env);
  emptyTree(checkout);
  archive(repo, headSha, checkout, null, env);
  rmSync(join(checkout, ".hunch"), { recursive: true, force: true });
  // The candidate cannot choose the memory graph or private overlay.
  archive(repo, baseSha, checkout, ".hunch", env);
  const syntheticHead = commit(checkout, "candidate source data", env);
  return { checkout, syntheticBase, syntheticHead };
}

function activeExecutablePolicy(repo) {
  const policyDir = join(repo, ".hunch", "policies");
  try {
    for (const name of readdirSync(policyDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(policyDir, name);
      if (lstatSync(path).isSymbolicLink()) return true;
      const policy = JSON.parse(readFileSync(path, "utf8"));
      if ((policy.state === "active_advisory" || policy.state === "active_blocking") && policy.assertion?.kind === "executable-behavior") return true;
    }
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function classifySarif(sarif, exitCode, stderr = "") {
  if (!sarif || sarif.version !== "2.1.0" || !Array.isArray(sarif.runs) || sarif.runs.length !== 1 || !Array.isArray(sarif.runs[0]?.results)) {
    return { verdict: "failure", reviewable: false, evaluation_complete: false, failure_classes: ["incomplete_evaluation"], findings: [] };
  }
  if (exitCode === null) return { verdict: "failure", reviewable: false, evaluation_complete: false, failure_classes: ["infrastructure_failure"], findings: [] };
  const classes = new Set();
  const results = sarif.runs[0].results;
  const findings = [...results.filter((result) => result?.level === "error"), ...results.filter((result) => result?.level !== "error")].slice(0, 64).map((result) => ({
    rule_id: typeof result?.ruleId === "string" ? result.ruleId.slice(0, 200) : "unknown",
    level: typeof result?.level === "string" ? result.level : "unknown",
    message: typeof result?.message?.text === "string" ? result.message.text.slice(0, 4096) : "missing SARIF message",
    ...(typeof result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri === "string" ? { file: result.locations[0].physicalLocation.artifactLocation.uri.slice(0, 1024) } : {}),
  }));
  for (const result of results) {
    if (!result || result.level !== "error" || typeof result.ruleId !== "string") continue;
    const text = typeof result.message?.text === "string" ? result.message.text : "";
    if (result.ruleId.startsWith("con_")) classes.add(REVIEWABLE);
    else if (result.ruleId.startsWith("pol_")) classes.add("policy_failure");
    else if (result.ruleId.startsWith("hunch/incomplete-scan")) classes.add("incomplete_evaluation");
    else if (text.includes("architectural conformance violated")) classes.add("conformance_failure");
    else if (text.includes("re-adds")) classes.add("regression");
    else if (text.includes("reverses rejected approach")) classes.add("veto");
    else classes.add("unknown");
  }
  if (stderr.trim()) classes.add("infrastructure_failure");
  if (exitCode !== 0 && classes.size === 0) classes.add(stderr.trim() ? "infrastructure_failure" : "unknown");
  return {
    verdict: classes.size ? "failure" : "pass",
    reviewable: classes.size === 1 && classes.has(REVIEWABLE),
    evaluation_complete: true,
    failure_classes: [...classes].sort(),
    findings,
  };
}

export { classifySarif, buildSyntheticRepo, activeExecutablePolicy };

function argument(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) fail(`missing ${name}`);
  return args[index + 1];
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  try {
    const args = process.argv.slice(2);
    const repo = argument(args, "--repo");
    const baseSha = sha(argument(args, "--base-sha"), "base SHA");
    const headSha = sha(argument(args, "--head-sha"), "head SHA");
    const prNumber = Number(argument(args, "--pr-number"));
    const runId = Number(argument(args, "--run-id"));
    const workflowSha = sha(argument(args, "--workflow-sha"), "workflow SHA");
    const triggerHeadSha = sha(argument(args, "--trigger-head-sha"), "trigger PR head SHA");
    const evaluatorVersion = required(argument(args, "--evaluator-version"), "evaluator version");
    const cli = required(argument(args, "--cli"), "trusted evaluator CLI");
    const output = argument(args, "--output");
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !Number.isSafeInteger(runId) || runId < 1) fail("PR number and run id must be positive integers");
    const temp = argument(args, "--temp");
    mkdirSync(temp, { recursive: true });
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(temp, "global.gitconfig"), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    const baseReport = {
      schema: "hunch.guard-report/1",
      pr_number: prNumber,
      head_sha: headSha,
      base_sha: baseSha,
      evaluator: { package: "@davesheffer/hunch", version: evaluatorVersion },
      source: { run_id: runId, workflow_path: ".github/workflows/hunch-guard-review-producer.yml", workflow_sha: workflowSha, event: "workflow_run", trigger_head_sha: triggerHeadSha },
    };
    if (triggerHeadSha !== headSha) fail("triggering guard run is stale for the current PR head");
    const synthetic = buildSyntheticRepo(repo, baseSha, headSha, temp, env);
    if (activeExecutablePolicy(synthetic.checkout)) {
      writeFileSync(output, `${JSON.stringify({ ...baseReport, verdict: "failure", reviewable: false, evaluation_complete: false, failure_classes: ["executable_policy_failure"], findings: [{ rule_id: "hunch/executable-policy", level: "error", message: "active executable-behavior policy requires a separately isolated trusted evaluation" }] }, null, 2)}\n`, { mode: 0o600 });
      process.exit(0);
    }
    const result = spawnSync(process.execPath, [cli, "check", "--base", synthetic.syntheticBase, "--strict", "--format", "sarif", "--public-only"], {
      cwd: synthetic.checkout,
      env: { ...env, HUNCH_PRIVATE_DIR: "" },
      shell: false,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: MAX_SARIF_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sarif = null;
    try { sarif = JSON.parse(result.stdout ?? ""); } catch { /* classifier records an incomplete evaluation */ }
    const classification = classifySarif(sarif, result.status ?? 1, result.stderr ?? "");
    const report = { ...baseReport, ...classification, evaluator: { package: "@davesheffer/hunch", version: evaluatorVersion, synthetic_base: synthetic.syntheticBase, synthetic_head: synthetic.syntheticHead } };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`Hunch guard producer failed closed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
