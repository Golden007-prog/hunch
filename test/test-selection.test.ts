import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildImportGraph, changedFiles, coverageFiles, entryTrusted, importSpecifiers, isDocsOnly, joinSegmentRuns, listRepoFiles, literalRepoPaths, selectTests, templatedRepoDirs, testDependencyModel,
  type ImpactEntry, type SelectionInput,
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

test("selectTests: a changed test file also selects tests that name it by path or basename", () => {
  const text: Record<string, string> = { "test/e.test.ts": `const drills = ["c.test.ts"];`, "test/d.test.ts": `const f = "test/c.test.ts";`, "test/b.test.ts": `"abc.test.ts"` };
  const sel = selectTests(input(["test/c.test.ts"], { testText: (t) => text[t] ?? "" }));
  assert.deepEqual(sel.tests, ["test/c.test.ts", "test/d.test.ts", "test/e.test.ts"]);
  assert.deepEqual(sel.reasons["test/e.test.ts"], ["mentions test/c.test.ts"]);
});

test("selectTests: a changed, added or deleted test file selects meta-tests that enumerate tests", () => {
  const text: Record<string, string> = {
    "test/d.test.ts": `for (const name of readdirSync(join(root, "test"))) if (name.endsWith(".test.ts")) check(name);`,
    "test/e.test.ts": `const index = JSON.parse(readFileSync(join(root, ".hunch", "index.json"), "utf8"));`,
  };
  const testText = (t: string) => text[t] ?? "";
  const changed = selectTests(input(["test/c.test.ts"], { testText }));
  assert.deepEqual(changed.tests, ["test/c.test.ts", "test/d.test.ts", "test/e.test.ts"]);
  assert.deepEqual(changed.reasons["test/d.test.ts"], ["enumerates test files (test/c.test.ts)"]);
  const deleted = selectTests(input(["test/gone.test.ts"], { testText }));
  assert.deepEqual([deleted.mode, deleted.tests], ["selected", ["test/d.test.ts", "test/e.test.ts"]]);
  const unread = selectTests(input(["test/gone.test.ts"]));
  assert.equal(unread.mode, "full", "a deleted test nothing reads is unattributed");
  assert.deepEqual(unread.unattributed, ["test/gone.test.ts"]);
  assert.equal(selectTests(input(["test/new-helper.ts"])).mode, "full", "a test helper keeps the code rules");
});

test("regression: a src file that names a test file selects that src file's dependents", () => {
  const root = gitRepo("hunch-verify-namer-", {
    "src/drills.ts": `export const drills = [{ file: "test/x.test.ts" }];\n`,
    "test/x.test.ts": "export {};\n",
    "test/y.test.ts": `import { drills } from "../src/drills.js";\n`,
    "test/z.test.ts": "export {};\n",
    "test/v.test.ts": "export {};\n",
  });
  try {
    const files = listRepoFiles(root);
    const model = testDependencyModel(root, files);
    assert.deepEqual(model.testNamers("test/x.test.ts"), ["src/drills.ts"]);
    writeFileSync(join(root, "test/x.test.ts"), "export const changed = 1;\n");
    const sel = selectTests({
      changedFiles: changedFiles(root), allTests: ["test/v.test.ts", "test/x.test.ts", "test/y.test.ts", "test/z.test.ts"],
      importGraph: model.dependencies, testText: model.testText, spawning: model.spawning, wholeProgram: model.wholeProgram,
      closureHash: model.closureHash, testNamers: model.testNamers,
    });
    assert.deepEqual([sel.mode, sel.tests], ["selected", ["test/x.test.ts", "test/y.test.ts"]]);
    assert.deepEqual(sel.reasons["test/y.test.ts"], ["imports src/drills.ts (names test/x.test.ts)"]);
  } finally { cleanupDir(root); }
});

test("regression: computed paths under a repo dir and bare src-relative names are dependencies", () => {
  const root = gitRepo("hunch-verify-computed-", {
    "src/core/x.ts": "export const x = 1;\n",
    "src/core/y.ts": "export const y = 1;\n",
    "src/other.ts": "export const o = 1;\n",
    "tooling/t.mjs": "export {};\n",
    "test/url.test.ts": "for (const p of list) readFileSync(new URL(`../src/${p}`, import.meta.url), \"utf8\");\n",
    "test/concat.test.ts": "readFileSync(\"tooling/\" + name, \"utf8\");\n",
    "test/join.test.ts": "readFileSync(join(ROOT, \"src\", name), \"utf8\");\n",
    "test/names.test.ts": "for (const p of [\"core/x.ts\"]) check(p);\n",
    "test/plain.test.ts": "readFileSync(join(ROOT, \"src\", \"other.ts\"));\n",
  });
  try {
    const model = testDependencyModel(root, listRepoFiles(root));
    for (const f of ["src/core/x.ts", "src/core/y.ts", "src/other.ts"]) {
      assert.ok(model.dependencies("test/url.test.ts").has(f), `template → ${f}`);
      assert.ok(model.dependencies("test/join.test.ts").has(f), `join with a computed arg → ${f}`);
    }
    assert.ok(model.dependencies("test/concat.test.ts").has("tooling/t.mjs"));
    assert.ok(!model.dependencies("test/concat.test.ts").has("src/other.ts"));
    assert.ok(model.dependencies("test/names.test.ts").has("src/core/x.ts"), "bare core/x.ts resolves under src/");
    assert.ok(!model.dependencies("test/names.test.ts").has("src/core/y.ts"));
    assert.deepEqual([...model.dependencies("test/plain.test.ts")], ["src/other.ts"], "all-literal join stays narrow");
    const tests = ["test/concat.test.ts", "test/join.test.ts", "test/names.test.ts", "test/plain.test.ts", "test/url.test.ts"];
    const sel = selectTests({ changedFiles: ["src/core/x.ts"], allTests: tests, importGraph: model.dependencies, testText: model.testText });
    assert.deepEqual([sel.mode, sel.tests], ["selected", ["test/join.test.ts", "test/names.test.ts", "test/url.test.ts"]]);
  } finally { cleanupDir(root); }
});

test("templatedRepoDirs: a computed segment right after the root reaches every dir; dir aliases reach their dir", () => {
  const dirs = new Set(["src", "tooling", "site"]);
  for (const text of [
    "readFileSync(`../${dir}/x.ts`)",
    "readFileSync(\"../\" + dir)",
    "readFileSync(resolve(__dirname, \"..\", dir, f))",
    "readFileSync(`${ROOT}/${dir}/${f}`)",
  ]) assert.deepEqual(templatedRepoDirs(text, dirs), ["site", "src", "tooling"], text);
  assert.deepEqual(templatedRepoDirs("const SRC = join(ROOT, \"src\");\nfor (const f of readdirSync(SRC)) read(join(SRC, f));", dirs), ["src"]);
  assert.deepEqual(templatedRepoDirs("const TOOLS = path.resolve(here, \"..\", \"tooling\");\nrun(`${TOOLS}/x.mjs`);", dirs), ["tooling"]);
  assert.deepEqual(templatedRepoDirs("const CLI = join(ROOT, \"src\", \"cli\", \"index.ts\");\nrun(CLI);", dirs), [], "a file alias stays literal");
  assert.deepEqual(templatedRepoDirs("const SRC = join(ROOT, \"src\");", dirs), [], "an unused alias reads nothing");
  assert.deepEqual(templatedRepoDirs("readFileSync(join(ROOT, \"src\", \"a.ts\")); name + \".\" + ext;", dirs), []);
});

const entry = (files: string[], over: Partial<ImpactEntry> = {}): ImpactEntry => ({ files, complete: true, commit: "abc", closureHash: "h1", ...over });
const mapOf = (map: Record<string, ImpactEntry>) => ({ version: 2, commit: "abc", map });

test("selectTests: impact-map attribution is unioned with the import graph (the map only adds)", () => {
  const impactMap = mapOf({ "test/e.test.ts": entry(["src/a.ts"]), "test/a.test.ts": entry([]) });
  const sel = selectTests(input(["src/a.ts", "src/c.ts"], { impactMap }));
  assert.equal(sel.mode, "selected");
  assert.deepEqual(sel.tests, ["test/a.test.ts", "test/c.test.ts", "test/e.test.ts"]);
  assert.deepEqual(sel.reasons["test/e.test.ts"], ["covers src/a.ts (impact map)"]);
  assert.deepEqual(sel.reasons["test/a.test.ts"], ["imports src/a.ts"], "an entry that omits the file never hides the graph");
  assert.deepEqual(sel.reasons["test/c.test.ts"], ["imports src/c.ts"]);
  assert.deepEqual(sel.mapUsed, ["test/e.test.ts"]);
  const mapOnly = selectTests(input(["src/new.ts"], { impactMap: mapOf({ "test/d.test.ts": entry(["src/new.ts"]) }) }));
  assert.deepEqual([mapOnly.mode, mapOnly.tests], ["selected", ["test/d.test.ts"]]);
});

test("selectTests: a spawning test reaches the whole program unless its map entry is trusted", () => {
  const whole = ["src/a.ts", "src/b.ts", "src/c.ts", "src/shared.ts", "src/deep.ts"];
  const base = { spawning: (t: string) => t === "test/d.test.ts", wholeProgram: whole, closureHash: "h1" };
  const none = selectTests(input(["src/deep.ts"], base));
  assert.deepEqual(none.tests, ["test/d.test.ts"]);
  assert.match(none.reasons["test/d.test.ts"]![0]!, /whole program/);
  const trusted = selectTests(input(["src/a.ts", "src/c.ts"], { ...base, impactMap: mapOf({ "test/d.test.ts": entry(["src/b.ts"]) }) }));
  assert.deepEqual(trusted.tests, ["test/a.test.ts", "test/c.test.ts"], "a complete entry with a matching closure hash narrows");
  assert.deepEqual(trusted.mapUsed, ["test/d.test.ts"]);
  for (const over of [{ complete: false }, { closureHash: "h0" }, { closureHash: "" }]) {
    const untrusted = selectTests(input(["src/a.ts", "src/c.ts"], { ...base, impactMap: mapOf({ "test/d.test.ts": entry(["src/b.ts"], over) }) }));
    assert.deepEqual(untrusted.tests, ["test/a.test.ts", "test/c.test.ts", "test/d.test.ts"], JSON.stringify(over));
  }
  const legacy = { version: 1, commit: "abc", map: { "test/d.test.ts": entry(["src/b.ts"], { complete: false, closureHash: "" }) } };
  assert.ok(selectTests(input(["src/a.ts", "src/c.ts"], { ...base, impactMap: legacy })).tests.includes("test/d.test.ts"));
  // A src file only spawning tests could reach, which no trusted entry covers, is unattributed → FULL.
  assert.equal(selectTests(input(["src/deep.ts"], { ...base, impactMap: mapOf({ "test/d.test.ts": entry(["src/b.ts"]) }) })).mode, "full");
  assert.equal(entryTrusted(undefined, "h1"), false);
});

test("selectTests: any non-code change runs FULL, even one a test names", () => {
  const text: Record<string, string> = { "test/e.test.ts": `readFileSync(join(root, "site", "changelog.html"))`, "test/d.test.ts": `const x = "data/fixture.json";` };
  for (const file of ["site/changelog.html", "data/fixture.json", "src/schema.json", "docs/guide.md"]) {
    const sel = selectTests(input(["src/c.ts", file], { testText: (t) => text[t] ?? "" }));
    assert.equal(sel.mode, "full", file);
    assert.match(sel.fullReason!, /non-code change/, file);
    assert.ok(sel.unattributed.includes(file), file);
  }
});

test("selectTests: repo-root markdown selects tests that mention it, else nothing", () => {
  const text: Record<string, string> = { "test/e.test.ts": `readFileSync(join(root, "CHANGELOG.md"))`, "test/d.test.ts": `const p = "README.md";` };
  const sel = selectTests(input(["CHANGELOG.md", "README.md"], { testText: (t) => text[t] ?? "" }));
  assert.deepEqual(sel.tests, ["test/d.test.ts", "test/e.test.ts"]);
  assert.deepEqual(sel.reasons["test/e.test.ts"], ["mentions CHANGELOG.md"]);
  assert.equal(selectTests(input(["NOTES.md"], { testText: (t) => text[t] ?? "" })).mode, "none");
});

test("regression: a test that walks a directory with readdirSync is not missed for an html edit", () => {
  const root = gitRepo("hunch-verify-walk-", {
    "site/index.html": "<a href=\"changelog.html\">x</a>\n",
    "site/changelog.html": "<p>log</p>\n",
    "test/links.test.ts": `import { readdirSync } from "node:fs";\nfor (const f of readdirSync("site")) check(f);\n`,
    "test/other.test.ts": "export {};\n",
    "test/third.test.ts": "export {};\n",
  });
  try {
    const files = listRepoFiles(root);
    const model = testDependencyModel(root, files);
    writeFileSync(join(root, "site/changelog.html"), "<a href=\"missing.html\">broken</a>\n");
    const sel = selectTests({
      changedFiles: changedFiles(root), allTests: ["test/links.test.ts", "test/other.test.ts", "test/third.test.ts"],
      importGraph: model.dependencies, testText: model.testText, spawning: model.spawning, wholeProgram: model.wholeProgram, closureHash: model.closureHash,
    });
    assert.equal(sel.mode, "full");
    assert.ok(sel.tests.includes("test/links.test.ts"));
  } finally { cleanupDir(root); }
});

test("joinSegmentRuns/literalRepoPaths: nested-paren join() arguments", () => {
  assert.deepEqual(joinSegmentRuns(`join(process.cwd(), "src", "cli", "index.ts")`), [["src", "cli", "index.ts"]]);
  assert.deepEqual(joinSegmentRuns(`resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tooling', 'x.mjs')`), [['..', 'tooling', 'x.mjs']]);
  const available = new Set(["src/cli/index.ts", "tooling/x.mjs"]);
  assert.deepEqual(literalRepoPaths(`const cli = join(process.cwd(), "src", "cli", "index.ts");`, "test/t.test.ts", available), ["src/cli/index.ts"]);
  assert.deepEqual(literalRepoPaths(`spawnSync(process.execPath, [join(ROOT, "tooling", "x.mjs")]);`, "test/t.test.ts", available), ["tooling/x.mjs"]);
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

test("testDependencyModel: spawn detection, literal repo paths, whole program, closure hash", () => {
  const root = gitRepo("hunch-verify-spawn-", {
    "src/cli/index.ts": `import "./run.js";\n`,
    "src/cli/run.ts": `import { x } from "../core/x.js";\n`,
    "src/mcp/server.ts": `import { y } from "../core/y.js";\n`,
    "src/core/x.ts": "export const x = 1;\n",
    "src/core/y.ts": "export const y = 1;\n",
    "src/core/z.ts": "export const z = 1;\n",
    "tooling/gate.mjs": `import "./lib.mjs";\n`,
    "tooling/lib.mjs": "export {};\n",
    "test/helper.ts": `import { spawnSync } from "node:child_process";\nexport const run = () => spawnSync(process.execPath, ["tooling/gate.mjs"]);\n`,
    "test/join.test.ts": `import { join } from "node:path";\nconst cli = join(ROOT, "src", "cli", "index.ts");\nexecFileSync(process.execPath, [cli]);\n`,
    "test/eval.test.ts": "spawnSync(process.execPath, [\"--eval\", \"await import('./src/mcp/server.js')\"]);\n",
    "test/viahelper.test.ts": `import { run } from "./helper.js";\nrun();\n`,
    "test/plain.test.ts": `import { x } from "../src/core/x.js";\n`,
  });
  try {
    const files = listRepoFiles(root);
    const model = testDependencyModel(root, files);
    assert.ok(model.dependencies("test/join.test.ts").has("src/core/x.ts"), "join(\"src\",\"cli\",\"index.ts\") resolves to the CLI closure");
    assert.ok(model.dependencies("test/eval.test.ts").has("src/core/y.ts"), "--eval import specifier resolves from the repo root");
    assert.ok(model.dependencies("test/viahelper.test.ts").has("tooling/lib.mjs"), "a helper-spawned entry script brings its closure");
    for (const t of ["test/join.test.ts", "test/eval.test.ts", "test/viahelper.test.ts"]) assert.equal(model.spawning(t), true, t);
    assert.equal(model.spawning("test/plain.test.ts"), false);
    assert.ok(model.wholeProgram.has("src/core/z.ts") && model.wholeProgram.has("tooling/lib.mjs"));
    assert.deepEqual(literalRepoPaths(`join(a, "src", "core", "x.ts")`, "test/t.ts", new Set(files)), ["src/core/x.ts"]);

    const tests = ["test/eval.test.ts", "test/join.test.ts", "test/plain.test.ts", "test/viahelper.test.ts"];
    const sel = selectTests({ changedFiles: ["src/core/z.ts"], allTests: tests, importGraph: model.dependencies, spawning: model.spawning, wholeProgram: model.wholeProgram, closureHash: model.closureHash });
    assert.equal(sel.mode, "full", "an unreferenced src file still reaches every spawning test (3 of 4 → too broad)");

    const before = model.closureHash;
    assert.equal(testDependencyModel(root, files).closureHash, before, "stable");
    writeFileSync(join(root, "src/core/x.ts"), "export const x = 2;\n");
    assert.equal(testDependencyModel(root, files).closureHash, before, "a content edit keeps the hash");
    writeFileSync(join(root, "src/cli/run.ts"), `import { x } from "../core/x.js";\nimport { z } from "../core/z.js";\n`);
    assert.notEqual(testDependencyModel(root, files).closureHash, before, "a new edge in the CLI closure changes it");
  } finally { cleanupDir(root); }
});

test("selectTests: an unattributed change goes FULL (fail-safe)", () => {
  const sel = selectTests(input(["src/c.ts", "src/new.ts"]));
  assert.equal(sel.mode, "full");
  assert.deepEqual(sel.unattributed, ["src/new.ts"]);
  assert.deepEqual(sel.tests, TESTS);
  assert.match(sel.fullReason!, /src\/new\.ts/);
});

test("selectTests: unmentioned repo-root markdown selects nothing; any other docs go FULL", () => {
  const sel = selectTests(input(["README.md", "AGENTS.md"]));
  assert.equal(sel.mode, "none");
  assert.deepEqual(sel.unattributed, []);
  assert.equal(isDocsOnly("docs/guide.md"), false);
  for (const file of ["pkg/notes.md", "docs/guide.md", "docs/guide.txt", "site/index.html", "src/notes.md", "test/README.md"]) {
    assert.equal(selectTests(input([file])).mode, "full", file);
  }
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
  const readMap = () => JSON.parse(readFileSync(join(root, ".hunch-cache/test-impact.json"), "utf8"));
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  try {
    // Without a map, the spawning test reaches the whole program (fail closed).
    writeFileSync(join(root, "src/a.mjs"), "export const a = 1; // touched\n");
    const unmapped = json();
    assert.deepEqual(unmapped.tests, ["test/a.test.mjs", "test/spawn.test.mjs"]);
    assert.match(unmapped.reasons["test/spawn.test.mjs"][0], /whole program/);
    reset();

    const refresh = verify("--refresh-map");
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.match(refresh.stdout, /wrote \.hunch-cache\/test-impact\.json: 4 tests/);
    const first = head();
    const written = readMap();
    assert.equal(written.commit, first);
    assert.ok(written.generatedAt && written.closureHash);
    const spawnEntry = written.map["test/spawn.test.mjs"];
    assert.ok(spawnEntry.files.includes("src/d.mjs"), JSON.stringify(written.map));
    assert.equal(spawnEntry.complete, true);
    assert.equal(spawnEntry.closureHash, written.closureHash);
    assert.ok(written.map["test/a.test.mjs"].files.includes("src/a.mjs"));

    // A trusted entry narrows the spawning test: a.mjs no longer selects it; d.mjs does via the map.
    writeFileSync(join(root, "src/a.mjs"), "export const a = 1; // touched\n");
    assert.deepEqual(json().tests, ["test/a.test.mjs"]);
    reset();
    writeFileSync(join(root, "src/d.mjs"), "export const d = 4; // touched\n");
    const viaMap = json();
    assert.deepEqual(viaMap.tests, ["test/spawn.test.mjs"]);
    assert.ok(viaMap.reasons["test/spawn.test.mjs"].includes("covers src/d.mjs (impact map)"));
    assert.ok(!viaMap.reasons["test/spawn.test.mjs"].includes("mentions src/d.mjs"), "\"child.mjs\" is not a mention of d.mjs");
    reset();

    // A real selected run passes, and a failing one propagates the runner's exit code (no shell).
    writeFileSync(join(root, "src/a.mjs"), "export const a = 1; // touched\n");
    const pass = verify();
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /running: node --test test\/a\.test\.mjs/);
    reset();
    writeFileSync(join(root, "src/c.mjs"), "export const c = 4;\n");
    const failRun = verify();
    assert.equal(failRun.status, 1, failRun.stdout + failRun.stderr);
    reset();

    // --only stamps only the refreshed entry with the new HEAD; the rest keep theirs.
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "next"], { cwd: root, stdio: "pipe" });
    const only = verify("--refresh-map", "--only", "test/a.test.mjs");
    assert.equal(only.status, 0, only.stderr);
    const merged = readMap();
    assert.deepEqual(Object.keys(merged.map), Object.keys(written.map));
    assert.equal(merged.map["test/a.test.mjs"].commit, head());
    assert.equal(merged.map["test/spawn.test.mjs"].commit, first);
    writeFileSync(join(root, "src/d.mjs"), "export const d = 4; // touched again\n");
    const stale = verify("--list");
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /1 impact-map entry used were recorded at another commit than HEAD .*test\/spawn\.test\.mjs/);
    reset();

    // A closure-hash mismatch untrusts the entry: the spawning test is back on the whole program.
    const tampered = readMap();
    tampered.map["test/spawn.test.mjs"].closureHash = "0".repeat(64);
    writeFileSync(join(root, ".hunch-cache/test-impact.json"), JSON.stringify(tampered));
    writeFileSync(join(root, "src/a.mjs"), "export const a = 1; // touched\n");
    assert.deepEqual(json().tests, ["test/a.test.mjs", "test/spawn.test.mjs"]);
  } finally { cleanupDir(root); }
});
