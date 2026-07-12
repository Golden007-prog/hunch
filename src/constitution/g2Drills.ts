import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runbook } from "../core/types.js";
import { shortHash } from "../core/ids.js";
import { canonicalHash } from "./canonical.js";
import type { G2Plan, G2RunbookCategory } from "./g2.js";
import { NODE_TEST_REPORTER_SOURCE, exactNodeTestPattern, nodeTestIsolationFlag, nodeTestReporterEvents } from "./nodeTestEvidence.js";

interface DrillSpec {
  file: string;
  name: string;
}

export const G2_OPERATIONAL_DRILLS: Record<G2RunbookCategory, DrillSpec> = {
  evaluator_error: {
    file: "test/constitution.test.ts",
    name: "neutral result algebra keeps not_applicable, unknown, and error distinct",
  },
  false_positive: {
    file: "test/constitution.test.ts",
    name: "Phase 2N shadow outcomes are append-only, disposition-bound, and precision-only",
  },
  private_leak: {
    file: "test/constitution.test.ts",
    name: "private evidence produces private policy/proof and public-only evaluation leaks no identifier",
  },
  stale_policy: {
    file: "test/constitution.test.ts",
    name: "proof is bound to policy semantics and cannot authorize a changed assertion",
  },
  provider_outage: {
    file: "test/cliproviders.test.ts",
    name: "HUNCH_SYNTH_PROVIDER=deterministic forces the offline heuristic",
  },
  corrupt_graph: {
    file: "test/constitution.test.ts",
    name: "corrupt policy JSON is a visible error, never a skipped false pass",
  },
  adapter_break: {
    file: "test/constitution.test.ts",
    name: "Gate G1 adapter contract: CLI, MCP, and strict CI expose the identical receipt",
  },
};

export interface G2OperationalDrillReceipt {
  id: string;
  content_hash: string;
  category: G2RunbookCategory;
  plan_id: string;
  runbook_id: string;
  runbook_hash: string;
  test: DrillSpec & { source_hash: string };
  runner: { name: "node-test-tsx"; isolation_flag: string };
  result: "passed" | "failed" | "error";
  exit_code: number | null;
  selected_event: "passed" | "failed" | null;
  error_code?: string;
  log_hash: string;
  data_class: "private";
  authority: "none";
  effects: "diagnostic_only";
  writes: "none";
}

export function executeG2OperationalDrill(
  root: string,
  plan: G2Plan,
  runbook: Runbook,
  category: G2RunbookCategory,
  timeoutMs = 120_000,
): G2OperationalDrillReceipt {
  if (plan.runbooks[category] !== runbook.id) throw new Error(`G2 ${category} drill does not bind plan runbook ${runbook.id}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("G2 drill timeout must be a positive integer no greater than 300000");
  const spec = G2_OPERATIONAL_DRILLS[category];
  const source = readFileSync(join(root, spec.file), "utf8");
  const session = mkdtempSync(join(tmpdir(), "hunch-g2-drill-"));
  const reporter = join(session, "reporter.mjs");
  writeFileSync(reporter, NODE_TEST_REPORTER_SOURCE);
  const isolationFlag = nodeTestIsolationFlag();
  const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: session,
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  const run = spawnSync(process.execPath, [
    tsx,
    "--test",
    isolationFlag,
    `--test-name-pattern=${exactNodeTestPattern(spec.name)}`,
    `--test-reporter=${pathToFileURL(reporter).href}`,
    "--test-reporter-destination=stdout",
    spec.file,
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  rmSync(session, { recursive: true, force: true });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const events = nodeTestReporterEvents(stdout).filter((event) => event.name === spec.name && !event.skip && !event.todo);
  const selectedEvent = events.length === 1 ? (events[0]!.type === "test:pass" ? "passed" as const : "failed" as const) : null;
  let result: G2OperationalDrillReceipt["result"] = "error";
  let errorCode: string | undefined;
  if (run.error) errorCode = (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "runner-failed";
  else if (run.signal) errorCode = "runner-signaled";
  else if (events.length === 0) errorCode = "selected-test-not-executed";
  else if (events.length > 1) errorCode = "selected-test-ambiguous";
  else if (selectedEvent === "passed" && run.status === 0) result = "passed";
  else if (selectedEvent === "failed" && run.status !== 0) result = "failed";
  else errorCode = "runner-outcome-inconsistent";
  const body = {
    category,
    plan_id: plan.id,
    runbook_id: runbook.id,
    runbook_hash: canonicalHash(runbook),
    test: { ...spec, source_hash: canonicalHash(source) },
    runner: { name: "node-test-tsx" as const, isolation_flag: isolationFlag },
    result,
    exit_code: run.status ?? null,
    selected_event: selectedEvent,
    ...(errorCode ? { error_code: errorCode } : {}),
    log_hash: canonicalHash({ stdout, stderr }),
    data_class: "private" as const,
    authority: "none" as const,
    effects: "diagnostic_only" as const,
    writes: "none" as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2drill_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}
