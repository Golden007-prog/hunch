import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir, writeLocalPointer } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";

/** Black-box coverage for the `hunch experiment respond` flags that change what is
 *  recorded: --rule / --rule-file (the kept rule, mutually exclusive), --inspected
 *  (arm C only), and the three guardrail incidents --confirmed-private-leak,
 *  --data-loss and --unsafe-evaluator, which must reach the run report's guardrail
 *  counts. EXP-03 is a human-review experiment, so no model or network is reached. */

const H = (c: string): string => `sha1:${c.repeat(40)}`;

interface Fixture { sandbox: string; root: string; privateDir: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }
interface Prereg { id: string; content_hash: string; registered_at: string }

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 180_000 });
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

function writeInput(f: Fixture, name: string, value: unknown): string {
  mkdirSync(join(f.sandbox, "inputs"), { recursive: true });
  const file = join(f.sandbox, "inputs", name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

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

function makeRepo(): Fixture {
  const sandbox = tempDir("hunch-cli-flags-respond-");
  const root = join(sandbox, "repo");
  const privateRoot = join(sandbox, "private");
  const privateDir = join(privateRoot, ".hunch");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, privateDir, env };
  for (const dir of [privateRoot, root]) {
    git(dir, env, "init", "-q", "-b", "main");
    for (const [k, v] of [["user.email", "flags@example.com"], ["user.name", "Flags"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(dir, env, "config", k!, v!);
  }
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "cli-flags-respond", private: true, type: "module" })}\n`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  assert.equal(hunch(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit").status, 0, "init");
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  writeLocalPointer(root, { privateDir, autoCommit: false, mode: "private" });
  return f;
}

function preregistration() {
  return {
    experiment: "EXP-03", revision: 2,
    hypothesis: "Fresh assigned treatment changes the locked primary outcome.",
    primary_metric: "accepted precise policies per reviewer hour",
    secondary_metrics: ["raw missing denominator"],
    unit: "policy_candidate",
    arms: [{ id: "A", description: "control" }, { id: "B", description: "partial" }, { id: "C", description: "full" }],
    assignment: { method: "blocked_randomized", unit: "policy_candidate", seed: "EXP-03-flags-seed" },
    strata: ["reviewer", "evidence_family"],
    inclusion: ["created after preregistration"],
    exclusion: ["old benchmark cases"],
    sample_plan: { minimum_per_arm: 2, target_per_arm: 2, maximum_total: 6, rationale: "Small executable CLI fixture." },
    analysis_plan: { primary_estimator: "raw arm rate", effect_size: "rate difference", uncertainty: "95 percent interval", missing_data: "retain all assignments", multiple_metrics: "one primary" },
    stopping_rule: "Stop only at fixed assignment cap or an independent guardrail.",
    guardrails: ["zero private leaks"],
    actor: "human:owner",
    reason: "Fresh CLI flag fixture preregistration.",
    supersedes: null,
  };
}

function bank(f: Fixture, reg: Prereg) {
  const createdAt = new Date(Math.max(Date.now(), Date.parse(reg.registered_at) + 1)).toISOString();
  return {
    experiment: "EXP-03", preregistration_id: reg.id, preregistration_hash: reg.content_hash,
    repository_root: f.root, base_commit: git(f.root, f.env, "rev-parse", "HEAD"),
    actor: "human:owner", reason: "Fresh held-out evidence cases.",
    cases: Array.from({ length: 6 }, (_, i) => ({
      id: `case-${i + 1}`, block: "reviewer-family-block", created_at: createdAt, held_out: true, used_for_tuning: false,
      strata: { reviewer: "reviewer", evidence_family: i % 2 ? "failure" : "correction" },
      evidence: `evidence ${i}`, required_relationship: `The payment action must verify the session ${i}`,
      manual_brief: `manual ${i}`, compiler_candidate: `candidate ${i}`, proof_card: `proof ${i}`,
      editable_bindings: [`binding ${i}`], target_commitment_hash: H(String((i % 9) + 1)),
    })),
  };
}

describe("cli flags: experiment respond", { timeout: 900_000 }, () => {
  let f: Fixture;
  let runId = "";
  const reviewer = ["--reviewer", "human:reviewer"];

  before(() => {
    f = makeRepo();
    const reg = okJson<{ appended: Prereg }>(hunch(f, "constitution", "g3", "--experiment", writeInput(f, "prereg.json", preregistration())), "prereg").appended;
    const b = okJson(hunch(f, "experiment", "prepare", writeInput(f, "bank.json", bank(f, reg))), "prepare");
    runId = okJson(hunch(f, "experiment", "create", b.id, "--sample-per-arm", "2", "--actor", "human:owner", "--reason", "Flags run."), "create").appended.id;
    okJson(hunch(f, "experiment", "qualify", writeInput(f, "qualify.json", { preregistration_id: reg.id, preregistration_hash: reg.content_hash,
      reviewer: "human:reviewer", protocol: "exp03-plain-language-comprehension-v2", cases_hash: H("f"), passed: true, reason: "Passed." })), "qualify");
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  test("experiment respond --rule with --rule-file is refused and writes nothing", () => {
    const assignment = okJson(hunch(f, "experiment", "next", runId, ...reviewer), "next").assignment.id;
    const before = snapshot(f.privateDir);
    refused(hunch(f, "experiment", "respond", runId, assignment, ...reviewer, "--choice", "edit", "--reason", "Tightened.",
      "--rule", "inline rule", "--rule-file", writeInput(f, "rule.txt", "file rule")), /pass --rule or --rule-file, not both/, "both rule sources");
    assert.deepEqual([...snapshot(f.privateDir).keys()], [...before.keys()], "refused respond writes nothing");
  });

  test("experiment respond --inspected is refused outside arm C and recorded in arm C; --rule and --rule-file supply the kept rule", () => {
    let refusedOutsideC = false;
    let inspectedInC = false;
    let viaFile = false;
    for (let i = 0; i < 6 && !(refusedOutsideC && inspectedInC); i++) {
      const next = okJson(hunch(f, "experiment", "next", runId, ...reviewer), "next");
      const { id, arm } = next.assignment as { id: string; arm: string };
      if (arm === "C") {
        const file = writeInput(f, `rule-${i}.txt`, "The payment action must verify the session first.\n");
        const out = okJson(hunch(f, "experiment", "respond", runId, id, ...reviewer, "--choice", "edit", "--reason", "Clarified it.",
          "--rule-file", file, "--inspected"), "respond --inspected in arm C");
        assert.equal(out.appended.metrics.decision, "accepted_edited");
        assert.equal(out.appended.metrics.proof_inspected, true, "--inspected is recorded in arm C");
        assert.ok(out.appended.metrics.result_hash, "the --rule-file text is the kept result");
        inspectedInC = viaFile = true;
        continue;
      }
      if (!refusedOutsideC) {
        refused(hunch(f, "experiment", "respond", runId, id, ...reviewer, "--choice", "reject", "--reason", "No.", "--inspected"),
          /supporting checks are only shown in arm C/, `--inspected in arm ${arm}`);
        refusedOutsideC = true;
      }
      const out = okJson(hunch(f, "experiment", "respond", runId, id, ...reviewer, "--choice", "edit", "--reason", "Reworded.",
        "--rule", `An edited rule ${i}.`), "respond --rule");
      assert.equal(out.appended.metrics.decision, "accepted_edited");
      assert.equal(out.appended.metrics.proof_inspected, false);
    }
    assert.ok(refusedOutsideC && inspectedInC && viaFile, "both arm branches were exercised");
  });

  test("experiment respond --confirmed-private-leak --data-loss --unsafe-evaluator are counted as guardrail incidents", () => {
    const before = okJson(hunch(f, "experiment", "report", runId), "report before").guardrails;
    assert.deepEqual([before.confirmed_private_leaks, before.data_loss_or_corruption, before.unsafe_evaluator_behavior], [0, 0, 0]);
    const assignment = okJson(hunch(f, "experiment", "next", runId, ...reviewer), "next").assignment.id;
    const out = okJson(hunch(f, "experiment", "respond", runId, assignment, ...reviewer, "--choice", "reject", "--reason", "Leaked a secret.",
      "--confirmed-private-leak", "--data-loss", "--unsafe-evaluator"), "respond with incidents");
    assert.deepEqual(out.appended.incidents, { confirmed_private_leak: true, data_loss_or_corruption: true, unsafe_evaluator_behavior: true });
    const g = out.report.guardrails;
    assert.deepEqual([g.confirmed_private_leaks, g.data_loss_or_corruption, g.unsafe_evaluator_behavior], [1, 1, 1]);
  });
});
