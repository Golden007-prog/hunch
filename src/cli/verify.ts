import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../core/config.js";
import { writeFileAtomic } from "../core/io.js";
import { hunchPaths } from "../core/paths.js";
import {
  buildImportGraph, changedFiles, coverageFiles, discoverTests, listRepoFiles, loadImpactMap, selectTests, spawnAwareGraph,
  type ChangeMode, type ImpactMap, type Selection,
} from "../core/testSelection.js";

export const DEFAULT_IMPACT_MAP = ".hunch-cache/test-impact.json";

interface VerifyOptions {
  staged?: boolean; base?: string; list?: boolean; full?: boolean; ci?: boolean; json?: boolean; map?: string;
  refreshMap?: boolean; only?: string[];
}

const quote = (arg: string): string => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;

function testScript(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.test === "string" ? pkg.scripts.test : null;
  } catch { return null; }
}

/** The shell command for a run. A configured template wins; otherwise this
 *  repo's runner when present, else `npm test` (full) / `npm test -- {files}`. */
export function verifyCommand(root: string, template: string | undefined, files: string[], extra: string[], full: boolean): string {
  const extraStr = extra.map(quote).join(" ");
  const withExtra = (cmd: string) => extraStr ? `${cmd} ${extraStr}` : cmd;
  if (full && !template && testScript(root)) return withExtra("npm test" + (extraStr ? " --" : ""));
  const tpl = template ?? (existsSync(join(root, "tooling/run-tests.mjs")) ? "node tooling/run-tests.mjs {files}" : "npm test -- {files}");
  const fileStr = files.map(quote).join(" ");
  return withExtra(tpl.includes("{files}") ? tpl.replace("{files}", fileStr) : `${tpl} ${fileStr}`.trim());
}

function printSelection(sel: Selection, total: number, note: string[]): void {
  for (const line of note) console.log(`  note: ${line}`);
  if (sel.mode === "none") { console.log("✓ no tests selected — nothing the changes can affect."); return; }
  if (sel.mode === "full") {
    console.log(`▶ FULL suite (${total} tests): ${sel.fullReason}`);
    if (sel.unattributed.length) console.log(`  unattributed: ${sel.unattributed.join(", ")}`);
    console.log("  hint: add an impact map (--map) or a test that imports the file to narrow this.");
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
 *  by spawned CLI/MCP children) and record the repo files each executed.
 *  Failing tests still contribute coverage. `only` merges into the old map. */
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
  const covDir = mkdtempSync(join(tmpdir(), "hunch-verify-cov-"));
  const map: Record<string, string[]> = { ...(previous?.map ?? {}) };
  const failed: string[] = [];
  const width = Math.max(1, opts.concurrency ?? availableParallelism() - 1);
  let next = 0;
  const worker = async () => {
    while (next < run.length) {
      const index = next++;
      const test = run[index]!;
      const dir = join(covDir, String(index));
      const cmd = verifyCommand(root, opts.template, [test], [], false);
      const status = await new Promise<number>((done) => {
        const child = spawn(cmd, { cwd: root, shell: true, stdio: "ignore", windowsHide: true, env: { ...process.env, NODE_V8_COVERAGE: dir } });
        child.on("error", () => done(1));
        child.on("close", (code) => done(code ?? 1));
      });
      if (status !== 0) failed.push(test);
      map[test] = coverageFiles(readCoverageDir(dir), root, repoFiles).filter((f) => f !== test);
      log(`  ${status === 0 ? "✓" : "✗"} ${test}  (${map[test]!.length} files)`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(width, run.length) }, worker));
  } finally {
    // Coverage is scratch; a straggling child holding a handle must not fail the refresh.
    try { rmSync(covDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }
  const sortedMap: Record<string, string[]> = {};
  for (const test of Object.keys(map).sort()) sortedMap[test] = map[test]!;
  const result: ImpactMap & { generatedAt: string } = { version: 1, commit: headSha(root), generatedAt: new Date().toISOString(), map: sortedMap };
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileAtomic(mapPath, JSON.stringify(result, null, 2) + "\n");
  return { map: result, failed: failed.sort() };
}

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify")
    .description("Run only the tests the current change can affect (fail-safe: unattributed changes run the full suite).")
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
        const covered = new Set(Object.values(map.map).flat()).size;
        console.log(`✓ wrote ${opts.map ?? DEFAULT_IMPACT_MAP}: ${Object.keys(map.map).length} tests → ${covered} files @ ${map.commit.slice(0, 12) || "(no HEAD)"}`);
        if (failed.length) console.log(`  ${failed.length} test file(s) failed (coverage still recorded): ${failed.join(", ")}`);
        return;
      }
      const note: string[] = [];
      let sel: Selection;
      if (opts.full || opts.ci) {
        sel = { mode: "full", tests: allTests, reasons: {}, fullReason: opts.ci ? "--ci" : "--full", unattributed: [] };
      } else {
        const mode: ChangeMode = opts.base ? { kind: "base", ref: opts.base } : opts.staged ? { kind: "staged" } : { kind: "worktree" };
        let impactMap: ImpactMap | undefined;
        try {
          impactMap = loadImpactMap(mapPath) ?? undefined;
        } catch (e) {
          note.push(`${(e as Error).message}; ignoring it`);
        }
        if (!impactMap && !note.length) note.push(`no impact map at ${opts.map ?? DEFAULT_IMPACT_MAP}; using the import graph (build one: hunch verify --refresh-map)`);
        const head = headSha(root);
        if (impactMap && impactMap.commit !== head) {
          note.push(`impact map is stale (built at ${impactMap.commit.slice(0, 12) || "?"}, HEAD ${head.slice(0, 12)}); still unioned with the import graph`);
        }
        const importGraph = spawnAwareGraph(root, buildImportGraph(root, files), files, impactMap);
        // The map itself is a derived cache; a not-yet-ignored copy is never a code change.
        const mapRel = relative(root, mapPath).replace(/\\/g, "/");
        const changed = changedFiles(root, mode).filter((f) => f !== mapRel);
        sel = selectTests({ changedFiles: changed, allTests, impactMap, importGraph });
      }
      if (opts.json) { console.log(JSON.stringify({ ...sel, total: allTests.length }, null, 2)); return; }
      printSelection(sel, allTests.length, note);
      if (opts.list || sel.mode === "none") return;
      const cmd = verifyCommand(root, template, sel.tests, runnerArgs, sel.mode === "full");
      console.log(`▶ running: ${cmd}\n`);
      const run = spawnSync(cmd, { cwd: root, shell: true, stdio: "inherit", windowsHide: true });
      if (run.error) { console.error(run.error.message); process.exitCode = 1; return; }
      process.exitCode = run.status ?? 1;
    });
}
