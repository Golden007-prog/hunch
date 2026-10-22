import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../core/config.js";
import { writeFileAtomic } from "../core/io.js";
import { hunchPaths } from "../core/paths.js";
import {
  buildImportGraph, changedFiles, coverageFiles, discoverTests, listRepoFiles, loadImpactMap, selectTests, testDependencyModel,
  type ChangeMode, type ImpactEntry, type ImpactMap, type Selection,
} from "../core/testSelection.js";

export const DEFAULT_IMPACT_MAP = ".hunch-cache/test-impact.json";

interface VerifyOptions {
  staged?: boolean; base?: string; list?: boolean; full?: boolean; ci?: boolean; json?: boolean; map?: string;
  refreshMap?: boolean; only?: string[];
}

function testScript(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.test === "string" ? pkg.scripts.test : null;
  } catch { return null; }
}

/** Split a command template into argv tokens; double/single quotes group. */
export function tokenize(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** npm without a shell: run npm-cli.js under this Node; POSIX may exec `npm`. */
function npmArgv(args: string[]): string[] {
  const dir = dirname(process.execPath);
  for (const cli of [join(dir, "node_modules/npm/bin/npm-cli.js"), join(dir, "../lib/node_modules/npm/bin/npm-cli.js")]) {
    if (existsSync(cli)) return [process.execPath, cli, ...args];
  }
  if (process.platform === "win32") throw new Error("cannot locate npm-cli.js; set verify.command in .hunch/config.json");
  return ["npm", ...args];
}

/** The runner argv (never a shell). A configured template wins (`{files}` expands
 *  to one argv entry per file); otherwise this repo's runner when present, else
 *  `npm test` (full) / `npm test -- <files>`. */
export function runnerArgv(root: string, template: string | undefined, files: string[], extra: string[], full: boolean): string[] {
  if (template) {
    const tokens = tokenize(template);
    const argv = tokens.includes("{files}") ? tokens.flatMap((t) => t === "{files}" ? files : [t]) : [...tokens, ...files];
    if (argv[0] === "node") argv[0] = process.execPath;
    return [...argv, ...extra];
  }
  if (full && testScript(root)) return npmArgv(["test", ...(extra.length ? ["--", ...extra] : [])]);
  if (existsSync(join(root, "tooling/run-tests.mjs"))) return [process.execPath, "tooling/run-tests.mjs", ...files, ...extra];
  return npmArgv(["test", "--", ...files, ...extra]);
}

const display = (argv: string[]): string => argv.map((a, i) => i === 0 && a === process.execPath ? "node" : /\s/.test(a) ? JSON.stringify(a) : a).join(" ");

function printSelection(sel: Selection, total: number, note: string[]): void {
  for (const line of note) console.log(`  note: ${line}`);
  if (sel.mode === "none") { console.log("✓ no tests selected — nothing the changes can affect."); return; }
  if (sel.mode === "full") {
    console.log(`▶ FULL suite (${total} tests): ${sel.fullReason}`);
    if (sel.unattributed.length) console.log(`  unattributed: ${sel.unattributed.join(", ")}`);
    console.log("  hint: `hunch verify --refresh-map` records per-test coverage so passing tests can narrow this.");
    return;
  }
  console.log(`▶ ${sel.tests.length} of ${total} tests selected:`);
  for (const test of sel.tests) console.log(`  ${test}  ← ${sel.reasons[test]!.join("; ")}`);
}

function headSha(root: string): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return ""; }
}

function readCoverageDir(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  const reports: unknown[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try { reports.push(JSON.parse(readFileSync(join(dir, name), "utf8"))); } catch { /* partial write → skip */ }
  }
  return reports;
}

/** Run each test in its own runner process under NODE_V8_COVERAGE (inherited
 *  by spawned CLI/MCP children) and record the repo files each executed. An
 *  entry is `complete` only when the test file passed and produced coverage;
 *  failing tests still record their (partial) files. `only` merges into the
 *  old map, keeping each untouched entry's own commit stamp. */
export async function refreshImpactMap(opts: {
  root: string; tests: string[]; files: string[]; template?: string; mapPath: string; only?: string[];
  concurrency?: number; log?: (line: string) => void;
}): Promise<{ map: ImpactMap; failed: string[] }> {
  const { root, mapPath } = opts;
  const log = opts.log ?? console.log;
  const run = opts.only?.length ? opts.only.map((t) => t.replace(/\\/g, "/").replace(/^\.\//, "")) : opts.tests;
  let previous: ImpactMap | null = null;
  if (opts.only?.length) { try { previous = loadImpactMap(mapPath); } catch { previous = null; } }
  const repoFiles = new Set(opts.files);
  const commit = headSha(root);
  const { closureHash } = testDependencyModel(root, opts.files, buildImportGraph(root, opts.files));
  const covDir = mkdtempSync(join(tmpdir(), "hunch-verify-cov-"));
  const map: Record<string, ImpactEntry> = { ...(previous?.map ?? {}) };
  const failed: string[] = [];
  const width = Math.max(1, opts.concurrency ?? availableParallelism() - 1);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a parent test runner must not turn the child into a reporter
  let next = 0;
  const worker = async () => {
    while (next < run.length) {
      const index = next++;
      const test = run[index]!;
      const dir = join(covDir, String(index));
      const argv = runnerArgv(root, opts.template, [test], [], false);
      const status = await new Promise<number>((done) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: root, stdio: "ignore", windowsHide: true, env: { ...env, NODE_V8_COVERAGE: dir } });
        child.on("error", () => done(1));
        child.on("close", (code) => done(code ?? 1));
      });
      const reports = readCoverageDir(dir);
      if (status !== 0) failed.push(test);
      const files = coverageFiles(reports, root, repoFiles).filter((f) => f !== test);
      map[test] = { files, complete: status === 0 && reports.length > 0, commit, closureHash };
      log(`  ${status === 0 ? "✓" : "✗"} ${test}  (${files.length} files)`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(width, run.length) }, worker));
  } finally {
    // Coverage is scratch; a straggling child holding a handle must not fail the refresh.
    try { rmSync(covDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }
  const sortedMap: Record<string, ImpactEntry> = {};
  for (const test of Object.keys(map).sort()) sortedMap[test] = map[test]!;
  const result: ImpactMap = { version: 2, commit, generatedAt: new Date().toISOString(), closureHash, map: sortedMap };
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileAtomic(mapPath, JSON.stringify(result, null, 2) + "\n");
  return { map: result, failed: failed.sort() };
}

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify")
    .description("Run only the tests the current change can affect (fail-closed: anything unattributed runs the full suite).")
    .argument("[runnerArgs...]", "extra arguments for the test runner (after --)")
    .option("--staged", "select from staged changes only")
    .option("--base <ref>", "select from merge-base(<ref>, HEAD)..HEAD plus the working tree")
    .option("--list", "print the selection with reasons; run nothing")
    .option("--full", "run the full suite")
    .option("--ci", "run the full suite (CI)")
    .option("--json", "print the selection as JSON; run nothing")
    .option("--map <path>", `test impact map (default ${DEFAULT_IMPACT_MAP})`)
    .option("--refresh-map", "rebuild the impact map: run each test under V8 coverage")
    .option("--only <tests...>", "with --refresh-map: refresh only these tests, merging into the existing map")
    .action(async (runnerArgs: string[], opts: VerifyOptions) => {
      let root: string;
      try {
        root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        console.error("hunch verify must run inside a git repository");
        process.exitCode = 1;
        return;
      }
      const config = readConfig(hunchPaths(root)).verify ?? {};
      const files = listRepoFiles(root);
      const allTests = discoverTests(files, typeof config.tests === "string" ? config.tests : undefined);
      const template = typeof config.command === "string" ? config.command : undefined;
      const mapPath = opts.map ? (isAbsolute(opts.map) ? opts.map : join(root, opts.map)) : join(root, DEFAULT_IMPACT_MAP);
      if (opts.refreshMap) {
        const total = opts.only?.length ?? allTests.length;
        console.log(`▶ refreshing impact map: ${total} test file(s) under V8 coverage`);
        const { map, failed } = await refreshImpactMap({ root, tests: allTests, files, template, mapPath, only: opts.only });
        const covered = new Set(Object.values(map.map).flatMap((e) => e.files)).size;
        console.log(`✓ wrote ${opts.map ?? DEFAULT_IMPACT_MAP}: ${Object.keys(map.map).length} tests → ${covered} files @ ${map.commit.slice(0, 12) || "(no HEAD)"}`);
        if (failed.length) console.log(`  ${failed.length} test file(s) failed (partial coverage recorded, not trusted): ${failed.join(", ")}`);
        return;
      }
      const note: string[] = [];
      let sel: Selection;
      if (opts.full || opts.ci) {
        sel = { mode: "full", tests: allTests, reasons: {}, fullReason: opts.ci ? "--ci" : "--full", unattributed: [], mapUsed: [] };
      } else {
        const mode: ChangeMode = opts.base ? { kind: "base", ref: opts.base } : opts.staged ? { kind: "staged" } : { kind: "worktree" };
        let impactMap: ImpactMap | undefined;
        try {
          impactMap = loadImpactMap(mapPath) ?? undefined;
        } catch (e) {
          note.push(`${(e as Error).message}; ignoring it`);
        }
        if (!impactMap && !note.length) note.push(`no impact map at ${opts.map ?? DEFAULT_IMPACT_MAP}; using the import graph (build one: hunch verify --refresh-map)`);
        const model = testDependencyModel(root, files, buildImportGraph(root, files));
        // The map itself is a derived cache; a not-yet-ignored copy is never a code change.
        const mapRel = relative(root, mapPath).replace(/\\/g, "/");
        const changed = changedFiles(root, mode).filter((f) => f !== mapRel);
        sel = selectTests({
          changedFiles: changed, allTests, impactMap, importGraph: model.dependencies,
          testText: model.testText, spawning: model.spawning, closureHash: model.closureHash,
          wholeProgram: [...model.wholeProgram, ...changed.filter((f) => f.startsWith("src/"))],
        });
        if (impactMap) {
          const head = headSha(root);
          const stale = sel.mapUsed.filter((t) => impactMap!.map[t]!.commit !== head);
          if (stale.length) note.push(`${stale.length} impact-map entr${stale.length === 1 ? "y" : "ies"} used were recorded at another commit than HEAD ${head.slice(0, 12)} (${stale.join(", ")}); the map only adds tests`);
          if (Object.values(impactMap.map).some((e) => e.closureHash !== model.closureHash)) {
            note.push("CLI/MCP/tooling import closure changed since some entries were recorded; those spawning tests use the whole program");
          }
        }
      }
      if (opts.json) { console.log(JSON.stringify({ ...sel, total: allTests.length }, null, 2)); return; }
      printSelection(sel, allTests.length, note);
      if (opts.list || sel.mode === "none") return;
      let argv: string[];
      try { argv = runnerArgv(root, template, sel.tests, runnerArgs, sel.mode === "full"); } catch (e) { console.error((e as Error).message); process.exitCode = 1; return; }
      console.log(`▶ running: ${display(argv)}\n`);
      const run = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "inherit", windowsHide: true });
      if (run.error) { console.error(run.error.message); process.exitCode = 1; return; }
      process.exitCode = run.status ?? 1;
    });
}
