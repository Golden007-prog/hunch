/**
 * Environment-variable surface gate. Every variable Hunch's source reads must be
 * registered in test/env-surface.json with a purpose and either the tests that
 * exercise it (each test's body must mention the variable) or an explicit todo.
 * New variables can never land as todo: the todo set is ratcheted against the
 * frozen baseline below, so adding an env read without a test fails CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveSpawnCommand } from "../src/core/spawnCommand.js";

const ROOT = process.cwd();
const NAME = "([A-Z][A-Za-z0-9_]*)";
/** Reads on process.env or an `env` alias of it; assignments and deletes are writes, not reads. */
const READS = [
  new RegExp(`(?<![\\w.])(?:process\\.env|env)\\??\\.${NAME}\\b(?!\\s*=(?!=))`, "g"),
  new RegExp(`(?<![\\w.])(?:process\\.env|env)\\??\\.?\\[\\s*["'\`]${NAME}["'\`]\\s*\\](?!\\s*=(?!=))`, "g"),
  // Helpers such as numEnv("HUNCH_RRF_K", 60) that read the variable by name.
  new RegExp(`\\b\\w*Env\\(\\s*["'\`]([A-Z][A-Z0-9_]*)["'\`]`, "g"),
];
/** Pass-through allowlists: `for (const key of ["PATH", ...]) if (process.env[key]) ...`. */
const PASSTHROUGH = /for \(const (\w+) of \[([^\]]*)\]\)\s*\{?\s*if \(process\.env\[\1\]\)/g;

interface Entry { class: string; purpose: string; tests?: { file: string; title: string }[]; todo?: string }
const registry = JSON.parse(readFileSync(join(ROOT, "test/env-surface.json"), "utf8")) as Record<string, Entry>;

/** Frozen: shrink only. A variable may be `todo` only if it was untested when this gate landed. */
const TODO_BASELINE = new Set([
  "SystemRoot", "WINDIR",
  "npm_config_registry", "HUNCH_GRAPH_GAMMA", "HUNCH_GRAPH_MAX_DEPTH", "HUNCH_GRAPH_NODE_CAP", "HUNCH_GRAPH_TOKEN_CAP",
  "HUNCH_MEMORY_PRIOR_SHIFT", "HUNCH_RRF_K", "HUNCH_RRF_W_FTS", "HUNCH_RRF_W_GRAPH", "HUNCH_RRF_W_SEM",
  "HUNCH_STALE_DECISION_PRIOR_WEIGHT", "HUNCH_STATE_HISTORY_SCORE_FACTOR", "HUNCH_TEAM_CLONE_DEBUG",
  "HUNCH_TEAM_CLONE_TIMEOUT_MS",
]);

function walk(dir: string, suffix: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, suffix, out);
    else if (path.endsWith(suffix)) out.push(path);
  }
  return out;
}

export function discoverEnvReads(root = ROOT): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)!.add(relative(root, file).replace(/\\/g, "/"));
  };
  for (const file of walk(join(root, "src"), ".ts")) {
    const src = readFileSync(file, "utf8");
    for (const re of READS) {
      for (const m of src.matchAll(re)) {
        if (/delete\s*$/.test(src.slice(Math.max(0, m.index! - 8), m.index))) continue;
        add(m[1]!, file);
      }
    }
    for (const m of src.matchAll(PASSTHROUGH)) {
      for (const key of m[2]!.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) add(key[1]!, file);
    }
  }
  return found;
}

/** Body of the top-level test titled `title`: from its `test(` to the next one. */
function testBody(file: string, title: string): string | null {
  const src = readFileSync(join(ROOT, file), "utf8");
  const starts = [...src.matchAll(/^\s*test\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm)];
  const i = starts.findIndex((m) => m[2] === title);
  if (i < 0) return null;
  return src.slice(starts[i]!.index, starts[i + 1]?.index ?? src.length);
}

/** Drop // and block comments (string-aware enough: skips quoted text) so a comment cannot satisfy the gate. */
function stripComments(src: string): string {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => (str ? m : " "));
}

/** The name must appear as a string literal, an object key, or an env assignment/delete, outside comments. */
function setsOrNamesVar(body: string, name: string): boolean {
  const code = stripComments(body);
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`["'\`]${n}["'\`]`),
    new RegExp(`(?<![\\w.])${n}\\s*:`),
    new RegExp(`\\benv\\??\\.${n}\\s*=(?!=)`),
    new RegExp(`\\bdelete\\s+(?:process\\.)?env\\.${n}\\b`),
  ].some((re) => re.test(code));
}

test("env surface: every environment variable src reads is registered, and nothing stale is", () => {
  const discovered = discoverEnvReads();
  const missing = [...discovered.keys()].filter((k) => !(k in registry)).sort();
  const stale = Object.keys(registry).filter((k) => !discovered.has(k)).sort();
  assert.deepEqual(missing, [], `unregistered env reads (add to test/env-surface.json with a test): ${missing.map((k) => `${k} in ${[...discovered.get(k)!].join(",")}`).join("; ")}`);
  assert.deepEqual(stale, [], "registered variables no longer read by src (remove them)");
});

test("env surface: each entry is documented and either tested or a baseline todo", () => {
  const unused: string[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    assert.ok(entry.purpose?.trim().length >= 10, `${name}: purpose required`);
    assert.ok(entry.class?.trim(), `${name}: class required`);
    const tests = entry.tests ?? [];
    if (!tests.length) {
      assert.ok(entry.todo?.trim(), `${name}: needs tests or a todo reason`);
      assert.ok(TODO_BASELINE.has(name), `${name}: new env variables must ship with a test; todo is closed to new entries`);
      continue;
    }
    assert.equal(entry.todo, undefined, `${name}: tested entries must drop their todo`);
    for (const t of tests) {
      assert.ok(existsSync(join(ROOT, t.file)), `${name}: ${t.file} missing`);
      const body = testBody(t.file, t.title);
      assert.ok(body !== null, `${name}: test "${t.title}" not found in ${t.file}`);
      if (!setsOrNamesVar(body!, name)) unused.push(`${name}: test "${t.title}" in ${t.file} never uses the variable as a string literal, env key or assignment (comments do not count)`);
    }
  }
  assert.deepEqual(unused, []);
});

test("env surface: discovery sees aliases, helper reads and pass-through lists but not writes", () => {
  const discovered = discoverEnvReads();
  for (const name of ["HUNCH_SYNTH_PROVIDER", "HUNCH_MCP_TOOLS", "HUNCH_RRF_K", "TMPDIR", "CI"]) assert.ok(discovered.has(name), name);
  // experimentRunner/cochange only assign these for a child; an assignment is not a read.
  for (const name of ["CLAUDE_CODE_SAFE_MODE", "FORCE_COLOR", "GIT_TERMINAL_PROMPT"]) assert.ok(!discovered.has(name), name);
  for (const name of discovered.keys()) assert.match(name, /^[A-Z]|_proxy$|^npm_config_/, `${name}: not an env name`);
  // no truncated names from regex backtracking
  for (const name of discovered.keys()) assert.ok(!/^(HUNCH_CLI_CONFI|GIT_INDEX_FIL)$/.test(name), name);
});

// Behavioural tests for variables no other test sets as a real input. Each body
// uses the variable as an env key, so the registry can point here honestly.

test("env surface: Windows lookup honors ComSpec, PATH and the Path spelling", () => {
  const exists = (p: string) => p.toLowerCase() === "c:\\tools\\tool.cmd";
  const resolve = (env: Record<string, string>) => resolveSpawnCommand(["tool", "x"], { platform: "win32", execPath: "C:\\node\\node.exe", env, exists });
  const viaPATH = resolve({ PATH: "C:\\tools", PATHEXT: ".CMD", ComSpec: "C:\\custom\\cmd.exe" });
  assert.equal(viaPATH.how, "cmd-shim");
  assert.equal(viaPATH.file, "C:\\custom\\cmd.exe");
  assert.equal(resolve({ Path: "C:\\tools", PATHEXT: ".CMD" }).how, "cmd-shim");
  assert.equal(resolve({ Path: "C:\\elsewhere", PATHEXT: ".CMD" }).how, "direct");
  assert.equal(resolve({ PATH: "C:\\tools", PATHEXT: ".CMD" }).file, "cmd.exe");
});

function runInChild(script: string, overrides: Record<string, string>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim().split("\n").at(-1)!;
}
const modUrl = (rel: string) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);

test("env surface: HUNCH_MAX_PRIOR_SHIFT and HUNCH_PRIOR_SHIFT_SCALE bound how far a dead hit's rank drops", () => {
  const script = `
    const { HunchStore } = await import(${modUrl("src/store/hunchStore.ts")});
    const s = Object.create(HunchStore.prototype);
    s.recs = () => []; s.staleDecisionIds = () => new Set();
    s.priorMeta = (ref) => (ref === "h0" ? { dead: true, provenance: [] } : null);
    const hits = Array.from({ length: 8 }, (_, i) => ({ ref: "h" + i, kind: "symbols", title: "", snippet: "", score: 1 }));
    console.log(JSON.stringify(s.rerankByPriors(hits, 10, undefined, ".").findIndex((h) => h.ref === "h0")));
  `;
  assert.equal(runInChild(script, {}), "3", "defaults clamp the shift at 4 positions (rank 0 lands behind three hits)");
  assert.equal(runInChild(script, { HUNCH_MAX_PRIOR_SHIFT: "2" }), "1");
  assert.equal(runInChild(script, { HUNCH_PRIOR_SHIFT_SCALE: "1" }), "0", "a tiny scale never moves the hit a whole position");
});

test("env surface: HUNCH_SIG_MIN_LINES sets the churn threshold for model synthesis", () => {
  const script = `
    const { isSignificant } = await import(${modUrl("src/synthesis/synthesize.ts")});
    const a = (n) => ({ addedSymbols: [], removedSymbols: [], changedSymbols: [], addedDeps: [], removedDeps: [], addedLines: n, removedLines: 0 });
    console.log(JSON.stringify([5, 13, 60].map((n) => isSignificant({ body: "" }, a(n), ["src/a.ts"]))));
  `;
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "" }), "[false,true,true]");
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "3" }), "[true,true,true]");
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "50" }), "[false,false,true]");
});
