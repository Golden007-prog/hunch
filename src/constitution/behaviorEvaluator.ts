import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { headSha, revExists } from "../extractors/git.js";
import { canonicalHash } from "./canonical.js";
import { nodeTestInfrastructureError } from "./g2BehaviorCandidates.js";
import { dependencySnapshotForCommit } from "./g2BehaviorDependencies.js";
import { cleanupReplayWorktree, hasUnsafeReplayFilter, replayGitArgs } from "./replay.js";
import {
  BEHAVIOR_POLICY_EVALUATOR,
  PolicyEvaluationSchema,
  type BehaviorExecution,
  type PolicyEvaluation,
  type PolicySpec,
} from "./schema.js";
import {
  NODE_TEST_REPORTER_SOURCE,
  exactNodeTestPattern,
  nodeTestIsolationFlag,
  nodeTestReporterEvents,
} from "./nodeTestEvidence.js";

export interface BehaviorEvaluationOptions {
  commit?: string;
  selectedName?: string;
}

function behaviorEnvironment(home: string, gitConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

function sourceAt(root: string, commit: string, file: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "show", `${commit}:${file}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function evaluation(
  policy: PolicySpec,
  commit: string,
  execution: Omit<BehaviorExecution, "execution_hash">,
  result: PolicyEvaluation["result"],
  explanation: string,
): PolicyEvaluation {
  const executionHash = canonicalHash(execution);
  const behavior: BehaviorExecution = { ...execution, execution_hash: executionHash };
  const body = {
    policy_id: policy.id,
    policy_revision: policy.revision,
    result,
    evaluator: { ...BEHAVIOR_POLICY_EVALUATOR },
    repository: { head: commit, graph_hash: executionHash },
    matches: [{ file: behavior.test.file, symbol: behavior.test.name }],
    explanation,
    evidence_refs: [...policy.evidence],
    behavior,
  };
  return PolicyEvaluationSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

export function evaluateExecutableBehaviorPolicy(
  root: string,
  policy: PolicySpec,
  opts: BehaviorEvaluationOptions = {},
): PolicyEvaluation {
  if (policy.assertion.kind !== "executable-behavior") {
    throw new Error(`policy ${policy.id} is not an executable-behavior policy`);
  }
  const assertion = policy.assertion;
  const commit = opts.commit ?? headSha(root);
  const selectedName = opts.selectedName ?? assertion.test.name;
  const baseExecution = {
    commit: /^[a-f0-9]{40}$/.test(commit) ? commit : "0".repeat(40),
    test: { file: assertion.test.file, name: selectedName, source_hash: assertion.test.source_hash },
    runner: assertion.runner,
    exit_code: null,
    selected_event: null,
  } as const;
  if (!/^[a-f0-9]{40}$/.test(commit) || !revExists(commit, root)) {
    return evaluation(policy, baseExecution.commit, { ...baseExecution, error_code: "commit-ref-unresolved" }, "error", "executable behavior commit does not resolve");
  }
  const source = sourceAt(root, assertion.test.source_commit, assertion.test.file);
  if (source == null || canonicalHash(source) !== assertion.test.source_hash) {
    return evaluation(policy, commit, { ...baseExecution, commit, error_code: "test-source-hash-mismatch" }, "error", "pinned behavior test source does not match its exact commit/hash binding");
  }
  const dependency = dependencySnapshotForCommit(root, commit, assertion.dependency_snapshot_ids);
  if (!dependency) {
    return evaluation(policy, commit, { ...baseExecution, commit, error_code: "dependency-snapshot-unavailable" }, "error", "no unique exact dependency snapshot is available for executable behavior evaluation");
  }

  const session = mkdtempSync(join(tmpdir(), "hunch-behavior-policy-"));
  const hooks = join(session, "hooks-disabled");
  const gitConfig = join(session, "global.gitconfig");
  const checkout = join(session, "checkout");
  const reporter = join(session, "reporter.mjs");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(gitConfig, "");
  writeFileSync(reporter, NODE_TEST_REPORTER_SOURCE);
  const env = behaviorEnvironment(session, gitConfig);
  let added = false;
  let result: PolicyEvaluation;
  try {
    if (hasUnsafeReplayFilter(root, env)) {
      result = evaluation(policy, commit, { ...baseExecution, commit, dependency_snapshot_id: dependency.snapshot.id, error_code: "unsafe-local-filter-config" }, "error", "repository has an unsafe local Git content filter");
    } else {
      execFileSync("git", replayGitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, commit]), {
        env,
        timeout: assertion.timeout_ms,
        stdio: "ignore",
      });
      added = true;
      symlinkSync(dependency.nodeModules, join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const testFile = join(checkout, assertion.test.file);
      mkdirSync(dirname(testFile), { recursive: true });
      writeFileSync(testFile, source);
      const common = [
        "--test",
        nodeTestIsolationFlag(),
        `--test-name-pattern=${exactNodeTestPattern(selectedName)}`,
        `--test-reporter=${pathToFileURL(reporter).href}`,
        "--test-reporter-destination=stdout",
        assertion.test.file,
      ];
      const args = assertion.runner === "node-test"
        ? common
        : [join(dependency.nodeModules, "tsx", "dist", "cli.mjs"), ...common];
      const run = spawnSync(process.execPath, args, {
        cwd: checkout,
        env,
        encoding: "utf8",
        timeout: assertion.timeout_ms,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      const matches = nodeTestReporterEvents(run.stdout ?? "")
        .filter((event) => event.name === selectedName && !event.skip && !event.todo);
      const exitCode = run.status ?? null;
      const execution = {
        ...baseExecution,
        commit,
        dependency_snapshot_id: dependency.snapshot.id,
        exit_code: exitCode,
        selected_event: matches.length === 1 ? (matches[0]!.type === "test:pass" ? "passed" as const : "failed" as const) : null,
      };
      if (run.error) {
        const code = (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "runner-failed";
        result = evaluation(policy, commit, { ...execution, error_code: code }, "error", `executable behavior runner ${code}`);
      } else if (run.signal) {
        result = evaluation(policy, commit, { ...execution, error_code: "runner-signaled" }, "error", `executable behavior runner exited by ${run.signal}`);
      } else if (matches.length === 0) {
        const infrastructure = nodeTestInfrastructureError(output) ?? "selected-test-not-executed";
        result = evaluation(policy, commit, { ...execution, error_code: infrastructure }, "error", `exact selected test produced no executed pass/fail event (${infrastructure})`);
      } else if (matches.length > 1) {
        result = evaluation(policy, commit, { ...execution, error_code: "selected-test-ambiguous" }, "error", "exact selected test name produced multiple executed events");
      } else if (matches[0]!.type === "test:pass" && exitCode === 0) {
        result = evaluation(policy, commit, execution, "satisfied", "exact selected executable behavior test passed");
      } else if (matches[0]!.type === "test:fail" && exitCode !== 0) {
        result = evaluation(policy, commit, execution, "violated", "exact selected executable behavior test failed");
      } else {
        result = evaluation(policy, commit, { ...execution, error_code: "runner-outcome-inconsistent" }, "error", "selected test event and runner exit code disagree");
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : added ? "runner-setup-failed" : "worktree-create-failed";
    result = evaluation(policy, commit, { ...baseExecution, commit, dependency_snapshot_id: dependency.snapshot.id, error_code: code }, "error", `executable behavior evaluation failed during isolated setup (${code})`);
  } finally {
    if (added && cleanupReplayWorktree(root, hooks, env, session, checkout)) {
      result = evaluation(policy, commit, { ...baseExecution, commit, dependency_snapshot_id: dependency.snapshot.id, error_code: "worktree-cleanup-failed" }, "error", "executable behavior worktree cleanup failed");
    } else if (!added) {
      rmSync(session, { recursive: true, force: true });
    }
  }
  return result!;
}
