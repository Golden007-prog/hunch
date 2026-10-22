import { cleanupDir, isolatedCliEnv, tempDir, writeLocalPointer } from "./fixtures.js";
/**
 * Black-box CLI coverage for every `hunch experiment` subcommand on a temp git
 * repo after `hunch init --no-providers`, with a configured private overlay.
 * Order mirrors real use: validate -> prepare -> create -> qualify -> run ->
 * status -> next/respond/submit -> followup -> report -> stop. Each subcommand
 * also has one refusal path that must exit non-zero and write nothing.
 *
 * No model or network is ever reached: EXP-01 `run` resolves a FAKE `claude`
 * executable prepended to PATH (a shell stub on POSIX, a hardlinked copy of the
 * node binary on Windows, where spawn without a shell only resolves .exe), and
 * the fake always exits non-zero, so the outcome is a retained invalid completion.
 * The seven-day follow-up cannot elapse in a live CLI run, so its success path is
 * seeded in-process with backdated timestamps and only the follow-up itself runs
 * through the CLI.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hunchCliArgs } from "./cli-invocation.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { ConstitutionService } from "../src/constitution/service.js";

const H = (c: string): string => `sha1:${c.repeat(40)}`;

interface Fixture { sandbox: string; root: string; privateDir: string; bin: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }

function makeEnv(sandbox: string, bin: string): NodeJS.ProcessEnv {
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });
  // Windows env keys are case-insensitive but object spreads keep "Path"; reuse it.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin}${process.platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
  return env;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hunchWith(f: Fixture, extra: NodeJS.ProcessEnv, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extra }, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function okJson<T = any>(r: Run, what: string): T {
  assert.equal(r.status, 0, `${what} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

function refused(r: Run, pattern: RegExp, what: string): void {
  assert.notEqual(r.status, 0, `${what} must exit non-zero:\n${r.stdout}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern, `${what} must explain the refusal`);
}

function writeJson(f: Fixture, name: string, value: unknown): string {
  const file = join(f.sandbox, "inputs", name);
  mkdirSync(join(f.sandbox, "inputs"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Every file in the private overlay except git internals. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current).sort()) {
      if (name === ".git") continue;
      const file = join(current, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(relative(dir, file).replace(/\\/g, "/"), readFileSync(file).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

function assertUnchanged(before: Map<string, string>, dir: string, what: string): void {
  const now = snapshot(dir);
  const added = [...now.keys()].filter((k) => !before.has(k));
  const changed = [...now.keys()].filter((k) => before.has(k) && before.get(k) !== now.get(k));
  const removed = [...before.keys()].filter((k) => !now.has(k));
  assert.deepEqual({ added, changed, removed }, { added: [], changed: [], removed: [] }, `${what} must write nothing`);
}

function records(f: Fixture, kind: string): string[] {
  const dir = join(f.privateDir, kind);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
}

/** A provider stub that answers --version and fails every agent invocation. */
function installFakeClaude(bin: string): void {
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const target = join(bin, "claude.exe");
    try { linkSync(process.execPath, target); } catch { copyFileSync(process.execPath, target); }
    return;
  }
  const script = join(bin, "claude");
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (fake claude)"; exit 0; fi\necho "$@" >> "${join(bin, "invocations.log")}"\nexit 3\n`);
  chmodSync(script, 0o755);
}

function makeRepo(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-exp-${label}-`);
  const root = join(sandbox, "repo");
  const privateRoot = join(sandbox, "private");
  const privateDir = join(privateRoot, ".hunch");
  const bin = join(sandbox, "bin");
  installFakeClaude(bin);
  mkdirSync(root, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  const f: Fixture = { sandbox, root, privateDir, bin, env: makeEnv(sandbox, bin) };
  git(privateRoot, f.env, "init", "-q", "-b", "main");
  git(root, f.env, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.email", "cli-exp@example.com"], ["user.name", "CLI EXP"], ["commit.gpgsign", "false"], ["maintenance.auto", "false"], ["gc.auto", "0"]]) {
    git(root, f.env, "config", key!, value!);
    git(privateRoot, f.env, "config", key!, value!);
  }
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-exp-${label}`, private: true, type: "module" }, null, 2)}\n`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "task.ts"), "export function task(): string { return 'todo'; }\n");
  git(root, f.env, "add", "-A");
  git(root, f.env, "commit", "-qm", "fixture: task");
  const init = hunch(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  assert.equal(init.status, 0, `init failed:\n${init.stdout}\n${init.stderr}`);
  git(root, f.env, "add", "-A");
  git(root, f.env, "commit", "-qm", "chore: hunch init scaffolding");
  writeLocalPointer(root, { privateDir, autoCommit: false, mode: "private" });
  return f;
}

function preregistration(experiment: "EXP-01" | "EXP-03", revision: number) {
  const unit = experiment === "EXP-01" ? "task" : "policy_candidate";
  return {
    experiment,
    revision,
    hypothesis: "Fresh assigned treatment changes the locked primary outcome.",
    primary_metric: experiment === "EXP-01" ? "policy violation rate" : "accepted precise policies per reviewer hour",
    secondary_metrics: ["raw missing denominator"],
    unit,
    arms: [{ id: "A", description: "control" }, { id: "B", description: "partial" }, { id: "C", description: "full" }],
    assignment: { method: "blocked_randomized", unit, seed: `${experiment}-cli-seed` },
    strata: experiment === "EXP-01" ? ["scenario", "model_version"] : ["reviewer", "evidence_family"],
    inclusion: ["created after preregistration"],
    exclusion: ["old benchmark cases"],
    sample_plan: { minimum_per_arm: 2, target_per_arm: 2, maximum_total: 6, rationale: "Small executable CLI fixture." },
    analysis_plan: {
      primary_estimator: "raw arm rate",
      effect_size: "risk or rate difference",
      uncertainty: "95 percent interval",
      missing_data: "retain all assignments",
      multiple_metrics: "one primary",
    },
    stopping_rule: "Stop only at fixed assignment cap or an independent guardrail.",
    guardrails: ["zero private leaks"],
    actor: "human:owner",
    reason: "Fresh CLI fixture preregistration.",
    supersedes: null,
  };
}

interface Prereg { id: string; content_hash: string; registered_at: string }

function exp03Bank(f: Fixture, reg: Prereg, createdAt: string, plain: boolean) {
  return {
    experiment: "EXP-03",
    preregistration_id: reg.id,
    preregistration_hash: reg.content_hash,
    repository_root: f.root,
    base_commit: git(f.root, f.env, "rev-parse", "HEAD"),
    actor: "human:owner",
    reason: "Fresh held-out evidence cases.",
    cases: Array.from({ length: 6 }, (_, index) => ({
      id: `case-${index + 1}`,
      block: "reviewer-family-block",
      created_at: createdAt,
      held_out: true,
      used_for_tuning: false,
      strata: { reviewer: "reviewer", evidence_family: index % 2 ? "failure" : "correction" },
      evidence: `evidence ${index}`,
      ...(plain ? { required_relationship: `The payment action must verify the session ${index}` } : {}),
      manual_brief: `manual ${index}`,
      compiler_candidate: `candidate ${index}`,
      proof_card: `proof ${index}`,
      editable_bindings: [`binding ${index}`],
      target_commitment_hash: H(String((index % 9) + 1)),
    })),
  };
}

function exp01Bank(f: Fixture, reg: Prereg, createdAt: string) {
  const evaluator = join(f.sandbox, "hidden-evaluator.mjs");
  writeFileSync(evaluator, "console.log(JSON.stringify({valid_completion:false,policy_violation:null,task_success:false,build_success:true,unknown_or_error:false,refusal:false,confirmed_private_leak:false,data_loss_or_corruption:false,unsafe_evaluator_behavior:false}));\n");
  const artifactHash = `sha1:${createHash("sha1").update(readFileSync(evaluator)).digest("hex")}`;
  return {
    experiment: "EXP-01",
    preregistration_id: reg.id,
    preregistration_hash: reg.content_hash,
    repository_root: f.root,
    base_commit: git(f.root, f.env, "rev-parse", "HEAD"),
    actor: "human:owner",
    reason: "Fresh hidden implementation cases.",
    cases: ["one", "two"].map((id) => ({
      id,
      block: "typescript-small-correctness",
      created_at: createdAt,
      held_out: true,
      used_for_tuning: false,
      strata: { scenario: id, model_version: "fake-model" },
      prompt: `Implement task ${id}.`,
      context: { decision: `decision ${id}`, rationale: `rationale ${id}`, executable_policy: `policy ${id}`, causal_incident: `incident ${id}` },
      setup: null,
      evaluator: { command: process.execPath, args: [evaluator], timeout_ms: 30_000, visibility: "hidden_external", artifact: evaluator, artifact_hash: artifactHash },
    })),
  };
}

function register(f: Fixture, experiment: "EXP-01" | "EXP-03", revision: number): Prereg {
  const file = writeJson(f, `prereg-${experiment}.json`, preregistration(experiment, revision));
  const out = okJson<{ appended: Prereg }>(hunch(f, "constitution", "g3", "--experiment", file), `constitution g3 --experiment ${experiment}`);
  assert.match(out.appended.id, /^expreg_[a-f0-9]{10}$/);
  return out.appended;
}

/** Strictly after the preregistration timestamp, so cases are "fresh". */
function freshNow(after: string): string {
  const now = Date.now();
  return new Date(Math.max(now, Date.parse(after) + 1)).toISOString();
}

describe("cli:experiment lifecycle on a private overlay", { timeout: 900_000 }, () => {
  let f: Fixture;
  let exp01: Prereg;
  let exp03: Prereg;
  let exp03BankFile = "";
  let exp01BankFile = "";
  let exp03BankId = "";
  let exp01BankId = "";
  let exp03RunId = "";
  let exp01RunId = "";
  let openAssignment = "";
  let respondedAssignment = "";

  before(() => {
    f = makeRepo("main");
    exp01 = register(f, "EXP-01", 1);
    exp03 = register(f, "EXP-03", 2);
    exp03BankFile = writeJson(f, "bank-exp03.json", exp03Bank(f, exp03, freshNow(exp03.registered_at), true));
    exp01BankFile = writeJson(f, "bank-exp01.json", exp01Bank(f, exp01, freshNow(exp01.registered_at)));
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  test("cli:experiment validate: content-addresses a draft bank without writing it; refuses an unknown preregistration", () => {
    const before = snapshot(f.privateDir);
    const bank = okJson(hunch(f, "experiment", "validate", exp03BankFile), "experiment validate");
    assert.match(bank.id, /^expbank_[a-f0-9]{10}$/);
    assert.equal(bank.experiment, "EXP-03");
    assert.equal(bank.preregistration_id, exp03.id);
    assert.equal(bank.cases.length, 6);
    assertUnchanged(before, f.privateDir, "experiment validate");

    const bad = writeJson(f, "bank-bad-prereg.json", { ...JSON.parse(readFileSync(exp03BankFile, "utf8")), preregistration_id: "expreg_0000000000" });
    refused(hunch(f, "experiment", "validate", bad), /must bind a current G3 preregistration: expreg_0000000000/, "validate with unknown preregistration");
    assertUnchanged(before, f.privateDir, "refused experiment validate");
  });

  test("cli:experiment prepare: locks both case banks into the private overlay; refuses a stale case", () => {
    const before = snapshot(f.privateDir);
    const stale = writeJson(f, "bank-stale.json", exp03Bank(f, exp03, new Date(Date.parse(exp03.registered_at) - 60_000).toISOString(), true));
    refused(hunch(f, "experiment", "prepare", stale), /case case-1 predates preregistration/, "prepare with a pre-registration case");
    assertUnchanged(before, f.privateDir, "refused experiment prepare");

    const bank03 = okJson(hunch(f, "experiment", "prepare", exp03BankFile), "experiment prepare EXP-03");
    const bank01 = okJson(hunch(f, "experiment", "prepare", exp01BankFile), "experiment prepare EXP-01");
    exp03BankId = bank03.id;
    exp01BankId = bank01.id;
    assert.equal(bank03.data_class, "private");
    assert.deepEqual(records(f, "experiment-case-banks"), [`${bank01.id}.json`, `${bank03.id}.json`].sort());
    assert.equal(JSON.parse(readFileSync(join(f.privateDir, "experiment-case-banks", `${bank03.id}.json`), "utf8")).content_hash, bank03.content_hash);
    assert.equal(existsSync(join(f.root, ".hunch", "experiment-case-banks")), false, "case banks never land in the public store");
  });

  test("cli:experiment create: writes one immutable run per preregistration; refuses provider misuse and unknown banks", () => {
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "create", "expbank_0000000000", "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "x"),
      /unknown private experiment case bank: expbank_0000000000/, "create with unknown bank");
    refused(hunch(f, "experiment", "create", exp03BankId, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "x", "--provider", "claude-cli", "--model", "m"),
      /EXP-03 is a human-review experiment and accepts no model provider/, "create EXP-03 with a provider");
    refused(hunch(f, "experiment", "create", exp01BankId, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "x"),
      /requires explicit --provider claude-cli\|codex-cli/, "create EXP-01 without a provider");
    assertUnchanged(before, f.privateDir, "refused experiment create");

    const run03 = okJson(hunch(f, "experiment", "create", exp03BankId, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "Fresh EXP-03 run."), "experiment create EXP-03");
    exp03RunId = run03.appended.id;
    assert.match(exp03RunId, /^exprun_[a-f0-9]{10}$/);
    assert.equal(run03.appended.assignments.length, 6);
    assert.equal(run03.report.status, "registered");
    assert.equal(run03.report.claim_allowed, false);

    const run01 = okJson(hunch(f, "experiment", "create", exp01BankId, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "Fresh EXP-01 run.", "--provider", "claude-cli", "--model", "fake-model", "--max-turns", "3"), "experiment create EXP-01");
    exp01RunId = run01.appended.id;
    assert.equal(run01.appended.runner.provider, "claude-cli");
    assert.equal(run01.appended.runner.model_version, "fake-model");
    assert.ok(run01.appended.runner.provider_version, "provider version comes from the fake CLI's --version");
    assert.deepEqual(records(f, "experiment-runs"), [`${exp01RunId}.json`, `${exp03RunId}.json`].sort());

    const dup = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "create", exp03BankId, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "Second run."),
      /already has immutable run/, "second run for one preregistration");
    assertUnchanged(dup, f.privateDir, "refused duplicate experiment create");
  });

  test("cli:experiment next: refuses a reviewer without the plain-language qualification", () => {
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "next", exp03RunId, "--reviewer", "human:reviewer"),
      /must pass the excluded plain-language comprehension check/, "next before qualification");
    assertUnchanged(before, f.privateDir, "refused experiment next");
  });

  test("cli:experiment qualify: records a bound reviewer qualification; refuses a mismatched preregistration hash", () => {
    const input = { preregistration_id: exp03.id, preregistration_hash: exp03.content_hash, reviewer: "human:reviewer", protocol: "exp03-plain-language-comprehension-v2", cases_hash: H("f"), passed: true, reason: "Reviewer passed the excluded comprehension check." };
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "qualify", writeJson(f, "qualify-bad.json", { ...input, preregistration_hash: H("0") })),
      /must bind the exact current preregistration/, "qualify with wrong hash");
    assertUnchanged(before, f.privateDir, "refused experiment qualify");

    const q = okJson(hunch(f, "experiment", "qualify", writeJson(f, "qualify.json", input)), "experiment qualify");
    assert.match(q.id, /^expreviewqual_[a-f0-9]{10}$/);
    assert.equal(q.reviewer, "human:reviewer");
    assert.deepEqual(records(f, "experiment-review-qualifications"), [`${q.id}.json`]);
  });

  test("cli:experiment run: executes one EXP-01 assignment against a fake provider and retains the failure; refuses EXP-03", () => {
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "run", exp03RunId), /automated run execution is available only for EXP-01/, "run on EXP-03");
    assertUnchanged(before, f.privateDir, "refused experiment run");

    const out = okJson(hunchWith(f, { HUNCH_INITIATOR: "claude-cli" }, "experiment", "run", exp01RunId, "--limit", "1", "--timeout-ms", "60000"), "experiment run");
    assert.equal(out.outcomes.length, 1);
    const [outcome] = out.outcomes;
    assert.notEqual(outcome.status, "completed", "a failing fake provider can never produce a scored completion");
    assert.equal(outcome.metrics, null);
    assert.equal(outcome.invocation_started, true, `fake provider must have been invoked: ${outcome.error_code}`);
    assert.equal(outcome.error_code, "agent-nonzero");
    assert.equal(out.report.status, "running");
    assert.equal(out.report.terminal, 1);
    assert.deepEqual(records(f, "experiment-outcomes"), [`${outcome.id}.json`]);
    if (process.platform !== "win32") {
      assert.match(readFileSync(join(f.bin, "invocations.log"), "utf8"), /-p .*--model fake-model --max-turns 3/);
    }
  });

  test("cli:experiment status: reports raw denominators per run; refuses an unknown run", () => {
    const s03 = okJson(hunch(f, "experiment", "status", exp03RunId), "experiment status EXP-03");
    assert.equal(s03.run_id, exp03RunId);
    assert.equal(s03.status, "registered");
    assert.equal(s03.assignments, 6);
    assert.equal(s03.unresolved.length, 6);
    const s01 = okJson(hunch(f, "experiment", "status", exp01RunId), "experiment status EXP-01");
    assert.equal(s01.status, "running");
    assert.equal(s01.unresolved.length, 5);
    refused(hunch(f, "experiment", "status", "exprun_0000000000"), /unknown private experiment run: exprun_0000000000/, "status of unknown run");
  });

  test("cli:experiment next: starts a timed review and reveals only the assigned arm", () => {
    const out = okJson(hunch(f, "experiment", "next", exp03RunId, "--reviewer", "human:reviewer"), "experiment next");
    assert.match(out.start.id, /^expreview_[a-f0-9]{10}$/);
    assert.equal(out.start.reviewer, "human:reviewer");
    assert.ok(["A", "B", "C"].includes(out.assignment.arm));
    assert.ok(out.treatment && out.review_guide?.question, "treatment and review guide are returned");
    openAssignment = out.assignment.id;
    assert.deepEqual(records(f, "experiment-review-starts"), [`${out.start.id}.json`]);
    // Resuming returns the same open review rather than starting another.
    const again = okJson(hunch(f, "experiment", "next", exp03RunId, "--reviewer", "human:reviewer"), "experiment next (resume)");
    assert.equal(again.start.id, out.start.id);
    assert.equal(records(f, "experiment-review-starts").length, 1);
  });

  test("cli:experiment respond: records a plain-language review outcome; refuses an accept without a rule", () => {
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "respond", exp03RunId, openAssignment, "--reviewer", "human:reviewer", "--choice", "accept", "--reason", "Looks right."),
      /requires the rule text it keeps/, "respond accept without rule");
    assertUnchanged(before, f.privateDir, "refused experiment respond");

    const out = okJson(hunch(f, "experiment", "respond", exp03RunId, openAssignment, "--reviewer", "human:reviewer", "--choice", "reject", "--reason", "The requirement does not support this rule."), "experiment respond");
    assert.equal(out.appended.assignment_id, openAssignment);
    assert.equal(out.appended.status, "completed");
    assert.equal(out.appended.metrics.decision, "rejected");
    assert.ok(out.appended.metrics.duration_ms >= 1, "duration is machine-derived from the start record");
    assert.equal(out.report.status, "running");
    respondedAssignment = openAssignment;
  });

  test("cli:experiment submit: retains an abandoned review via the raw path; refuses a raw answer on a revision-2 case", () => {
    const next = okJson(hunch(f, "experiment", "next", exp03RunId, "--reviewer", "human:reviewer"), "experiment next (second)");
    const assignment = next.assignment.id as string;
    assert.notEqual(assignment, respondedAssignment);
    const raw = { reviewer: "human:reviewer", decision: "rejected", precise: false, proof_inspected: false, result: null, silent_semantic_substitution: false, rejection_reason: "not supported", confirmed_private_leak: false, data_loss_or_corruption: false, unsafe_evaluator_behavior: false, reason: "Raw answer." };
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "submit", exp03RunId, assignment, writeJson(f, "submit-raw.json", raw)),
      /revision-2 plain-language case; submit it with the standardized response template \(hunch experiment respond\)/, "submit a raw answer on rev-2");
    assertUnchanged(before, f.privateDir, "refused experiment submit");

    const out = okJson(hunch(f, "experiment", "submit", exp03RunId, assignment, writeJson(f, "submit-abandoned.json", { ...raw, decision: "abandoned", rejection_reason: null, reason: "Reviewer walked away." })), "experiment submit");
    assert.equal(out.appended.assignment_id, assignment);
    assert.equal(out.appended.metrics.decision, "abandoned");
    assert.equal(out.report.terminal, 2);
    assert.equal(out.report.unresolved.length, 4);
  });

  test("cli:experiment followup: refuses before seven full days have elapsed", () => {
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "followup", exp03RunId, respondedAssignment, writeJson(f, "followup.json", { reviewer: "human:reviewer", reversed: false, missing_reason: null, notes: "Still holds." })),
      /seven-day follow-up cannot be recorded before seven full days/, "followup too early");
    assertUnchanged(before, f.privateDir, "refused experiment followup");
  });

  test("cli:experiment report: emits a deterministic, authority-free receipt; refuses an unknown run", () => {
    const first = hunch(f, "experiment", "report", exp03RunId);
    const report = okJson(first, "experiment report");
    assert.equal(hunch(f, "experiment", "report", exp03RunId).stdout, first.stdout, "report is deterministic");
    assert.equal(report.run_id, exp03RunId);
    assert.equal(report.experiment, "EXP-03");
    assert.equal(report.claim_allowed, false);
    assert.equal(report.authority, "none");
    assert.equal(report.terminal, 2);
    assert.deepEqual(report.arms.map((arm: { arm: string }) => arm.arm), ["A", "B", "C"]);
    assert.match(report.analysis.deterministic_hash, /^sha1:/);
    refused(hunch(f, "experiment", "report", "exprun_0000000000"), /unknown private experiment run/, "report of unknown run");
  });

  test("cli:experiment stop: irreversibly stops a run and blocks further reviews; refuses a second, different stop", () => {
    const evidence = [H("a")];
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "stop", exp03RunId, writeJson(f, "stop-bad.json", { category: "boredom", actor: "human:owner", reason: "x", evidence_hashes: evidence })),
      /category|invalid/i, "stop with an unknown category");
    assertUnchanged(before, f.privateDir, "refused experiment stop");

    const out = okJson(hunch(f, "experiment", "stop", exp03RunId, writeJson(f, "stop.json", { category: "provider_wide_unavailability", actor: "human:owner", reason: "Independent outage evidence.", evidence_hashes: evidence })), "experiment stop");
    assert.match(out.appended.id, /^expstop_[a-f0-9]{10}$/);
    assert.equal(out.appended.effect, "irreversible_run_stop");
    assert.equal(out.report.status, "guardrail_stopped");
    assert.equal(okJson(hunch(f, "experiment", "status", exp03RunId), "status after stop").status, "guardrail_stopped");

    const stopped = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "stop", exp03RunId, writeJson(f, "stop-2.json", { category: "confirmed_private_leak", actor: "human:owner", reason: "Another stop.", evidence_hashes: [H("b")] })),
      /already irreversibly stopped/, "second stop");
    refused(hunch(f, "experiment", "next", exp03RunId, "--reviewer", "human:reviewer"), /stopped by an independently recorded safety\/privacy guardrail/, "next after stop");
    assertUnchanged(stopped, f.privateDir, "refused commands after stop");
  });
});

describe("cli:experiment followup after seven days", { timeout: 300_000 }, () => {
  let f: Fixture;
  let runId = "";
  let assignmentId = "";

  before(() => {
    f = makeRepo("followup");
    // The seven-day clock cannot elapse in a live CLI run: seed a revision-1
    // EXP-03 review in-process with backdated timestamps, then follow up via CLI.
    const day = 86_400_000;
    const at = (daysAgo: number, ms = 0): string => new Date(Date.now() - daysAgo * day + ms).toISOString();
    const store = new HunchStore(hunchPaths(f.root));
    try {
      const service = new ConstitutionService(store, f.root);
      const reg = service.registerG3Experiment(preregistration("EXP-03", 1) as Parameters<ConstitutionService["registerG3Experiment"]>[0], { now: at(10) });
      const bank = service.lockExperimentCaseBank(exp03Bank(f, reg, at(10, 1000), false) as Parameters<ConstitutionService["lockExperimentCaseBank"]>[0], { now: at(10, 2000) });
      const run = service.createExperimentRun(bank.id, { sample_per_arm: 2, actor: "human:owner", reason: "Backdated run." }, { now: at(10, 3000) });
      const next = service.nextExperimentReview(run.id, "human:reviewer", { now: at(9) });
      service.submitExperimentReview(run.id, next.assignment.id, {
        reviewer: "human:reviewer", decision: "rejected", precise: false, proof_inspected: false, result: null,
        silent_semantic_substitution: false, rejection_reason: "not supported", confirmed_private_leak: false,
        data_loss_or_corruption: false, unsafe_evaluator_behavior: false, reason: "Rejected on review.",
      }, { now: at(9, 60_000) });
      runId = run.id;
      assignmentId = next.assignment.id;
    } finally {
      store.close();
    }
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  test("cli:experiment followup: appends the seven-day reversal measurement; refuses an assignment with no outcome", () => {
    const input = { reviewer: "human:reviewer", reversed: false, missing_reason: null, notes: "Decision still holds after seven days." };
    const report = okJson(hunch(f, "experiment", "status", runId), "status before followup");
    const other = (report.unresolved as string[])[0]!;
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "followup", runId, other, writeJson(f, "followup-none.json", input)), /has no current outcome to follow up/, "followup without outcome");
    assertUnchanged(before, f.privateDir, "refused experiment followup");

    const out = okJson(hunch(f, "experiment", "followup", runId, assignmentId, writeJson(f, "followup.json", input)), "experiment followup");
    assert.match(out.appended.id, /^expfollow_[a-f0-9]{10}$/);
    assert.equal(out.appended.assignment_id, assignmentId);
    assert.equal(out.appended.reversed, false);
    assert.deepEqual(records(f, "experiment-followups"), [`${out.appended.id}.json`]);
  });
});
