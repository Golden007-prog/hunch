import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildImportGraph, changedFiles, coverageFiles, importSpecifiers, listRepoFiles, selectTests, spawnAwareGraph, type SelectionInput,
} from "../src/core/testSelection.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";

const TESTS = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts"];
const GRAPH: Record<string, string[]> = {
  "test/a.test.ts": ["src/a.ts", "src/shared.ts"],
  "test/b.test.ts": ["src/b.ts", "src/shared.ts"],
  "test/c.test.ts": ["src/c.ts"],
  "test/d.test.ts": [],
  "test/e.test.ts": [],
};
const input = (changed: string[], extra: Partial<SelectionInput> = {}): SelectionInput => ({
  changedFiles: changed,
  allTests: TESTS,
  importGraph: (t) => new Set(GRAPH[t] ?? []),
  ...extra,
});

test("selectTests: a changed test file selects itself", () => {
  const sel = selectTests(input(["test/c.test.ts"]));
  assert.equal(sel.mode, "selected");
  assert.deepEqual(sel.tests, ["test/c.test.ts"]);
  assert.deepEqual(sel.reasons["test/c.test.ts"], ["changed test file"]);
});

test("selectTests: a changed src file falls back to the import graph without a map", () => {
  const sel = selectTests(input(["src/shared.ts"]));
  assert.equal(sel.mode, "selected");
  assert.deepEqual(sel.tests, ["test/a.test.ts", "test/b.test.ts"]);
  assert.deepEqual(sel.reasons["test/b.test.ts"], ["imports src/shared.ts"]);
});

test("selectTests: impact-map attribution is unioned with the import graph (the map only adds)", () => {
  const impactMap = { version: 1, commit: "abc", map: { "test/e.test.ts": ["src/a.ts"] } };
  const sel = selectTests(input(["src/a.ts", "src/c.ts"], { impactMap }));
  assert.equal(sel.mode, "selected");
  assert.deepEqual(sel.tests, ["test/a.test.ts", "test/c.test.ts", "test/e.test.ts"]);
  assert.deepEqual(sel.reasons["test/e.test.ts"], ["covers src/a.ts (impact map)"]);
  assert.deepEqual(sel.reasons["test/a.test.ts"], ["imports src/a.ts"]);
  assert.deepEqual(sel.reasons["test/c.test.ts"], ["imports src/c.ts"]);
  const mapOnly = selectTests(input(["src/new.ts"], { impactMap: { version: 1, commit: "abc", map: { "test/d.test.ts": ["src/new.ts"] } } }));
  assert.deepEqual([mapOnly.mode, mapOnly.tests], ["selected", ["test/d.test.ts"]]);
});

test("coverageFiles: V8 coverage → repo files with an executed range", () => {
  const root = tempDir("hunch-verify-cov-unit-");
  try {
    const url = (rel: string) => pathToFileURL(join(root, rel)).href;
    const fn = (count: number) => ({ functionName: "", isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 10, count }] });
    const report = { result: [
      { scriptId: "1", url: url("src/a.ts"), functions: [fn(1)] },
      { scriptId: "2", url: url("src/never.ts"), functions: [fn(0)] },
      { scriptId: "3", url: `${url("src/b.ts")}?tsx-namespace=1`, functions: [fn(0), fn(2)] },
      { scriptId: "4", url: "node:internal/main", functions: [fn(1)] },
      { scriptId: "5", url: url("node_modules/x/index.js"), functions: [fn(1)] },
      { scriptId: "6", url: pathToFileURL(join(dirname(root), "outside.ts")).href, functions: [fn(1)] },
    ] };
    const repo = new Set(["src/a.ts", "src/b.ts", "src/never.ts"]);
    assert.deepEqual(coverageFiles([report, { result: [{ url: url("src/a.ts"), functions: [fn(3)] }] }, null, {}], root, repo), ["src/a.ts", "src/b.ts"]);
  } finally { cleanupDir(root); }
});

test("spawnAwareGraph: a CLI/MCP-spawning test depends on the entry's closure unless the map covers it", () => {
  const root = gitRepo("hunch-verify-spawn-", {
    "src/cli/index.ts": `import "./run.js";\n`,
    "src/cli/run.ts": `import { x } from "../core/x.js";\n`,
    "src/mcp/server.ts": `import { y } from "../core/y.js";\n`,
    "src/core/x.ts": "export const x = 1;\n",
    "src/core/y.ts": "export const y = 1;\n",
    "test/cli.test.ts": `import { hunchCliArgs } from "./cli-invocation.js";\nspawnSync(process.execPath, hunchCliArgs("check"));\n`,
    "test/mcp.test.ts": `const t = new StdioClientTransport({ command: "hunch mcp" });\n`,
    "test/plain.test.ts": "export {};\n",
  });
  try {
    const files = listRepoFiles(root);
    const tests = ["test/cli.test.ts", "test/mcp.test.ts", "test/plain.test.ts"];
    const graph = spawnAwareGraph(root, buildImportGraph(root, files), files);
    assert.ok(graph("test/cli.test.ts").has("src/core/x.ts"));
    assert.ok(!graph("test/cli.test.ts").has("src/core/y.ts"));
    assert.ok(graph("test/mcp.test.ts").has("src/core/y.ts"));
    assert.equal(graph("test/plain.test.ts").size, 0);
    const sel = selectTests({ changedFiles: ["src/core/x.ts"], allTests: tests, importGraph: graph });
    assert.equal(sel.mode, "full"); // cli + mcp = 2 of 3: conservative, too broad
    assert.match(sel.fullReason!, /too broad/);
    const impactMap = { version: 1, commit: "x", map: { "test/cli.test.ts": ["src/cli/index.ts"], "test/mcp.test.ts": ["src/mcp/server.ts"] } };
    const mapped = spawnAwareGraph(root, buildImportGraph(root, files), files, impactMap);
    assert.ok(!mapped("test/cli.test.ts").has("src/core/x.ts"), "a mapped test uses its map entry, not the CLI closure");
  } finally { cleanupDir(root); }
});

test("selectTests: an unattributed change goes FULL (fail-safe)", () => {
  const sel = selectTests(input(["src/c.ts", "src/new.ts"]));
  assert.equal(sel.mode, "full");
  assert.deepEqual(sel.unattributed, ["src/new.ts"]);
  assert.deepEqual(sel.tests, TESTS);
  assert.match(sel.fullReason!, /src\/new\.ts/);
});

test("selectTests: docs-only changes select nothing", () => {
  const sel = selectTests(input(["README.md", "docs/guide.txt", "site/index.html", "pkg/notes.md"]));
  assert.equal(sel.mode, "none");
  assert.deepEqual(sel.tests, []);
  assert.deepEqual(sel.unattributed, []);
});

test("selectTests: full triggers force FULL with that reason", () => {
  for (const file of ["package.json", "package-lock.json", "tsconfig.build.json", "tooling/run-tests.mjs", "test/fixtures.ts", "test/helpers-git.ts", "test/cli-invocation.ts", ".github/workflows/ci.yml"]) {
    const sel = selectTests(input(["src/c.ts", file]));
    assert.equal(sel.mode, "full", file);
    assert.match(sel.fullReason!, /full-suite trigger/, file);
  }
  const custom = selectTests(input(["src/c.ts"], { fullTriggers: ["src/c.ts"] }));
  assert.equal(custom.mode, "full");
});

test("selectTests: selecting more than 60% of the suite goes FULL", () => {
  const sel = selectTests(input(["src/shared.ts", "src/c.ts", "test/d.test.ts"]));
  assert.equal(sel.mode, "full");
  assert.match(sel.fullReason!, /too broad \(4 of 5/);
  const ok = selectTests(input(["src/shared.ts", "src/c.ts"]));
  assert.equal(ok.mode, "selected"); // 3 of 5 = 60% is not above the cap
});

test("selectTests: gate maps attribute by glob; output is sorted and deterministic", () => {
  const sel = selectTests(input(["src/z/deep.ts", "src/c.ts"], { gateMaps: { "test/d.test.ts": ["src/z/**"] } }));
  assert.deepEqual(sel.tests, ["test/c.test.ts", "test/d.test.ts"]);
  const again = selectTests(input(["src/c.ts", "src/z/deep.ts", "src/c.ts"], { gateMaps: { "test/d.test.ts": ["src/z/**"] } }));
  assert.deepEqual(again, sel);
  assert.equal(selectTests(input([])).mode, "none");
});

test("importSpecifiers: static, type, re-export, side-effect, dynamic", () => {
  const src = `import a from "./a.js";\nimport type { B } from './b.js';\nimport {\n  c,\n  d as e,\n} from "./c.js";\nimport "./side.js";\nexport * from "./re.js";\nexport { f } from "./f.js";\nconst g = await import("./g.js");\nconst h = import(variable);`;
  assert.deepEqual(importSpecifiers(src), ["./a.js", "./b.js", "./c.js", "./side.js", "./re.js", "./f.js", "./g.js"]);
});

function gitRepo(prefix: string, files: Record<string, string>): string {
  const root = tempDir(prefix);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return root;
}

const LAYOUT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "tiny", scripts: { test: "node --test" } }),
  "README.md": "# tiny\n",
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": `import { a } from "./a.js";\nexport const b = a + 1;\n`,
  "src/c.ts": "export const c = 3;\n",
  "src/lazy.ts": "export const lazy = 4;\n",
  "test/a.test.ts": `import { a } from "../src/a.js";\n`,
  "test/b.test.ts": `import { b } from "../src/b.js";\n`,
  "test/c.test.ts": `import { c } from "../src/c.js";\nawait import("../src/lazy.js");\n`,
};

test("buildImportGraph: transitive closure, .js→.ts mapping, dynamic import, deleted files stay attributable", () => {
  const root = gitRepo("hunch-verify-graph-", LAYOUT);
  try {
    let graph = buildImportGraph(root);
    assert.deepEqual([...graph("test/b.test.ts")].sort(), ["src/a.ts", "src/b.ts"]);
    assert.ok(graph("test/c.test.ts").has("src/lazy.ts"));
    rmSync(join(root, "src/c.ts"));
    graph = buildImportGraph(root);
    assert.ok(graph("test/c.test.ts").has("src/c.ts"), "a deleted import is still a candidate path");
  } finally { cleanupDir(root); }
});

test("changedFiles: working tree, staged, base and renames", () => {
  const root = gitRepo("hunch-verify-changed-", LAYOUT);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    g("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src/c.ts"), "export const c = 30;\n");
    g("commit", "-qam", "c");
    g("mv", "src/lazy.ts", "src/eager.ts");
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "src/new.ts"), "export {};\n");
    assert.deepEqual(changedFiles(root), ["src/a.ts", "src/eager.ts", "src/lazy.ts", "src/new.ts"]);
    assert.deepEqual(changedFiles(root, { kind: "staged" }), ["src/eager.ts", "src/lazy.ts"]);
    assert.deepEqual(changedFiles(root, { kind: "base", ref: "main" }), ["src/a.ts", "src/c.ts", "src/eager.ts", "src/lazy.ts", "src/new.ts"]);
  } finally { cleanupDir(root); }
});

test("hunch verify --list on a temp repo: src change, package.json, README", () => {
  const root = gitRepo("hunch-verify-cli-", LAYOUT);
  const env = isolatedCliEnv();
  const verify = (...args: string[]) => {
    const run = spawnSync(process.execPath, hunchCliArgs("verify", ...args), { cwd: root, env, encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  const reset = () => execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "pipe" });
  try {
    writeFileSync(join(root, "src/c.ts"), "export const c = 33;\n");
    const listed = verify("--list");
    assert.match(listed, /1 of 3 tests selected/);
    assert.match(listed, /test\/c\.test\.ts {2}← imports src\/c\.ts/);
    assert.doesNotMatch(listed, /test\/a\.test\.ts|test\/b\.test\.ts/);
    assert.match(listed, /no impact map/);
    const json = JSON.parse(verify("--json"));
    assert.equal(json.mode, "selected");
    assert.deepEqual(json.tests, ["test/c.test.ts"]);
    reset();

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tiny", version: "2.0.0" }));
    const full = JSON.parse(verify("--json"));
    assert.equal(full.mode, "full");
    assert.match(full.fullReason, /package\.json matches full-suite trigger/);
    assert.match(verify("--list"), /FULL suite \(3 tests\)/);
    reset();

    writeFileSync(join(root, "README.md"), "# tiny, edited\n");
    const none = JSON.parse(verify("--json"));
    assert.equal(none.mode, "none");
    assert.match(verify("--list"), /no tests selected/);
  } finally { cleanupDir(root); }
});

const RUN_LAYOUT: Record<string, string> = {
  ".gitignore": ".hunch-cache/\n",
  ".hunch/config.json": JSON.stringify({ verify: { tests: "test/**/*.test.mjs", command: "node --test {files}" } }),
  "package.json": JSON.stringify({ name: "tiny-run", type: "module" }),
  "src/a.mjs": "export const a = 1;\n",
  "src/c.mjs": "export const c = 3;\n",
  "src/d.mjs": "export const d = 4;\n",
  "src/child.mjs": `import { d } from "./d.mjs";\nif (d !== 4) process.exit(1);\n`,
  "test/a.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.mjs";\ntest("a", () => assert.equal(a, 1));\n`,
  "test/c.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\nimport { c } from "../src/c.mjs";\ntest("c", () => assert.equal(c, 3));\n`,
  "test/e.test.mjs": `import test from "node:test";\ntest("e", () => {});\n`,
  "test/spawn.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\nimport { spawnSync } from "node:child_process";\n` +
    `test("spawn", () => assert.equal(spawnSync(process.execPath, ["src/child.mjs"]).status, 0));\n`,
};

test("hunch verify --refresh-map, map-driven selection through a spawned child, and a real selected run", () => {
  const root = gitRepo("hunch-verify-run-", RUN_LAYOUT);
  // The fixture's own `node --test` must run as a top-level runner, not as a
  // child reporting to this suite's runner.
  const env = isolatedCliEnv({ NODE_TEST_CONTEXT: undefined });
  const verify = (...args: string[]) => spawnSync(process.execPath, hunchCliArgs("verify", ...args), { cwd: root, env, encoding: "utf8", windowsHide: true });
  const json = () => { const r = verify("--json"); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const reset = () => execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "pipe" });
  try {
    // Without a map, only a spawned child reaches src/d.mjs: fail-safe FULL.
    writeFileSync(join(root, "src/d.mjs"), "export const d = 4; // touched\n");
    assert.equal(json().mode, "full");
    reset();

    const refresh = verify("--refresh-map");
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.match(refresh.stdout, /wrote \.hunch-cache\/test-impact\.json: 4 tests/);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const written = JSON.parse(readFileSync(join(root, ".hunch-cache/test-impact.json"), "utf8"));
    assert.equal(written.version, 1);
    assert.equal(written.commit, head);
    assert.ok(written.generatedAt);
    assert.ok(written.map["test/spawn.test.mjs"].includes("src/d.mjs"), JSON.stringify(written.map));
    assert.ok(written.map["test/a.test.mjs"].includes("src/a.mjs"));

    writeFileSync(join(root, "src/d.mjs"), "export const d = 4; // touched\n");
    const viaMap = json();
    assert.equal(viaMap.mode, "selected");
    assert.deepEqual(viaMap.tests, ["test/spawn.test.mjs"]);
    assert.deepEqual(viaMap.reasons["test/spawn.test.mjs"], ["covers src/d.mjs (impact map)"]);
    reset();

    // A real selected run passes, and a failing one propagates the runner's exit code.
    writeFileSync(join(root, "src/a.mjs"), "export const a = 1; // touched\n");
    const pass = verify();
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /running: node --test test\/a\.test\.mjs/);
    reset();
    writeFileSync(join(root, "src/c.mjs"), "export const c = 4;\n");
    const failRun = verify();
    assert.equal(failRun.status, 1, failRun.stdout + failRun.stderr);
    reset();

    // --only merges into the existing map; a new commit makes the map stale but still used.
    const only = verify("--refresh-map", "--only", "test/a.test.mjs");
    assert.equal(only.status, 0, only.stderr);
    const merged = JSON.parse(readFileSync(join(root, ".hunch-cache/test-impact.json"), "utf8"));
    assert.deepEqual(Object.keys(merged.map), Object.keys(written.map));
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "next"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "src/d.mjs"), "export const d = 4; // touched again\n");
    const stale = verify("--list");
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /impact map is stale/);
    assert.match(stale.stdout, /test\/spawn\.test\.mjs/);
  } finally { cleanupDir(root); }
});
