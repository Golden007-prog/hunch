/** Change-scoped test selection for `hunch verify` (dec_70d82c408e). Pure
 *  selection rules over injected inputs, plus the git/filesystem readers that
 *  feed them. FAIL CLOSED: a change nothing can attribute runs the full suite,
 *  and a test that starts a child process is assumed to reach the whole program
 *  unless a trustworthy impact-map entry narrows it. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatchesGlob } from "./glob.js";
import { relativeImportCandidates } from "./relativeImports.js";

/** One test's coverage record. `complete` = the test file passed (ran to the
 *  end, so its coverage is whole); `closureHash` = the entry-closure hash at
 *  refresh time; `commit` = HEAD when this entry was recorded. */
export interface ImpactEntry {
  files: string[];
  complete: boolean;
  commit: string;
  closureHash: string;
}

export interface ImpactMap {
  version: number;
  commit: string;
  generatedAt?: string;
  closureHash?: string;
  /** test file → coverage entry (repo-relative posix). */
  map: Record<string, ImpactEntry>;
}

export interface SelectionInput {
  changedFiles: string[];
  allTests: string[];
  impactMap?: ImpactMap;
  /** Static dependencies of a test: transitive imports plus the closures of
   *  repo paths its text names (see `testDependencyModel`). */
  importGraph: (testFile: string) => Set<string>;
  fullTriggers?: string[];
  /** Extra per-test globs: a changed file matching one selects that test. */
  gateMaps?: Record<string, string[]>;
  /** Source text of a test (and its non-src helpers), for path/basename mentions. */
  testText?: (testFile: string) => string;
  /** Does the test start a child process (directly or through a helper)? */
  spawning?: (testFile: string) => boolean;
  /** Every file a spawned child could execute (all src/ plus tooling closures). */
  wholeProgram?: Iterable<string>;
  /** Entry-closure hash computed now; a map entry is trusted only if it matches. */
  closureHash?: string;
}

export interface Selection {
  mode: "selected" | "full" | "none";
  tests: string[];
  reasons: Record<string, string[]>;
  fullReason?: string;
  unattributed: string[];
  /** Tests whose impact-map entry attributed a change or narrowed a spawning test. */
  mapUsed: string[];
}

export const DEFAULT_FULL_TRIGGERS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig*.json",
  "tooling/run-tests.mjs",
  "test/fixtures.ts",
  "test/helpers*",
  "test/cli-invocation.ts",
  ".github/workflows/**",
];

/** Markdown outside src/ and test/ that no test mentions selects nothing. */
export function isDocsOnly(file: string): boolean {
  return pathMatchesGlob(file, "**/*.md") && !file.startsWith("src/") && !file.startsWith("test/");
}

/** Selected tests above this share of the suite run the full suite instead. */
export const MAX_SELECTED_SHARE = 0.6;

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const TS_FILE = /\.tsx?$/;
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** A basename mention bounded by non-path characters ("d.mjs" ≠ "child.mjs"). */
const mentionRe = (name: string): RegExp => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

/** A map entry may narrow a spawning test only when it is complete and was
 *  recorded against the same entry closure as now. */
export function entryTrusted(entry: ImpactEntry | undefined, closureHash: string | undefined): boolean {
  return !!entry && entry.complete === true && !!entry.closureHash && entry.closureHash === closureHash;
}

export function selectTests(input: SelectionInput): Selection {
  const changed = sorted(input.changedFiles.map(norm));
  const allTests = sorted(input.allTests.map(norm));
  const testSet = new Set(allTests);
  const triggers = input.fullTriggers ?? DEFAULT_FULL_TRIGGERS;
  const whole = new Set(input.wholeProgram ?? []);
  const entries = input.impactMap?.map ?? {};
  const reasons = new Map<string, Set<string>>();
  const unattributed: string[] = [];
  const mapUsed = new Set<string>();
  let triggerReason: string | undefined;
  const pick = (test: string, why: string) => {
    if (!testSet.has(test)) return;
    let set = reasons.get(test);
    if (!set) reasons.set(test, set = new Set());
    set.add(why);
  };

  for (const file of changed) {
    const trigger = triggers.find((g) => pathMatchesGlob(file, g));
    if (trigger) {
      triggerReason ??= `${file} matches full-suite trigger ${trigger}`;
      continue;
    }
    let attributed = false;
    const hit = (test: string, why: string) => { pick(test, why); attributed = true; };
    if (testSet.has(file)) hit(file, "changed test file");
    for (const [test, globs] of Object.entries(input.gateMaps ?? {})) {
      if (globs.some((g) => pathMatchesGlob(file, g))) hit(norm(test), `gate map covers ${file}`);
    }
    if (!testSet.has(file)) {
      const mentionable = !TS_FILE.test(file);
      for (const test of allTests) {
        const entry = entries[test];
        // The map only ever ADDS: a stale or partial entry never hides a test
        // the static graph (or the whole-program rule) still attributes.
        if (entry?.files.includes(file)) { hit(test, `covers ${file} (impact map)`); mapUsed.add(test); }
        if (input.importGraph(test).has(file)) hit(test, `imports ${file}`);
        if (whole.has(file) && input.spawning?.(test)) {
          if (entryTrusted(entry, input.closureHash)) mapUsed.add(test);
          else hit(test, `spawns a process without a trusted impact-map entry → whole program (${file})`);
        }
        if (mentionable && input.testText) {
          const text = input.testText(test);
          if (text.includes(file) || mentionRe(basename(file)).test(text)) hit(test, `mentions ${file}`);
        }
      }
    }
    if (!attributed && !isDocsOnly(file)) unattributed.push(file);
  }

  const reasonRecord: Record<string, string[]> = {};
  for (const test of sorted(reasons.keys())) reasonRecord[test] = sorted(reasons.get(test)!);
  const selected = Object.keys(reasonRecord);
  const used = sorted(mapUsed);
  const full = (fullReason: string): Selection => ({ mode: "full", tests: allTests, reasons: reasonRecord, fullReason, unattributed, mapUsed: used });

  if (triggerReason) return full(triggerReason);
  if (unattributed.length) {
    const more = unattributed.length > 1 ? ` (+${unattributed.length - 1} more)` : "";
    return full(`no test attributed to ${unattributed[0]}${more}`);
  }
  if (selected.length > allTests.length * MAX_SELECTED_SHARE) {
    return full(`selection too broad (${selected.length} of ${allTests.length} > ${MAX_SELECTED_SHARE * 100}%)`);
  }
  if (!selected.length) return { mode: "none", tests: [], reasons: {}, unattributed, mapUsed: used };
  return { mode: "selected", tests: selected, reasons: reasonRecord, unattributed, mapUsed: used };
}

// ---- repo readers ---------------------------------------------------------

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Tracked + untracked (non-ignored) repo files, repo-relative posix, sorted. */
export function listRepoFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return sorted(out.split("\0").filter(Boolean).map(norm).filter((f) => existsSync(join(root, f))));
}

export function discoverTests(files: string[], glob = "test/**/*.test.ts"): string[] {
  return sorted(files.filter((f) => pathMatchesGlob(f, glob)));
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_RE = /(?:\bimport\s*(?:type\s+)?(?:[\w*{}\s,$]+?\s*from\s*)?|\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

/** Static imports, re-exports, `import()`/`require()` with literal specifiers. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push(m[1]!);
  return out;
}

/** Transitive relative-import closure per file, memoized for this call. An
 *  unresolvable relative specifier (e.g. a deleted file) records every
 *  candidate path, so the deletion stays attributable to its importers. */
export function buildImportGraph(root: string, files: string[] = listRepoFiles(root)): (file: string) => Set<string> {
  const available = new Set(files);
  const direct = new Map<string, string[]>();
  const edges = (file: string): string[] => {
    let deps = direct.get(file);
    if (deps) return deps;
    deps = [];
    if (CODE_FILE.test(file) && available.has(file)) {
      let text = "";
      try { text = readFileSync(join(root, file), "utf8"); } catch { /* unreadable → no edges */ }
      for (const spec of importSpecifiers(text)) {
        const candidates = relativeImportCandidates(file, spec);
        const hit = candidates.find((c) => available.has(c));
        if (hit) deps.push(hit);
        else deps.push(...candidates);
      }
    }
    direct.set(file, deps);
    return deps;
  };
  const closure = new Map<string, Set<string>>();
  return (file: string): Set<string> => {
    const start = norm(file);
    const cached = closure.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...edges(start)];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next) || next === start) continue;
      seen.add(next);
      stack.push(...edges(next));
    }
    closure.set(start, seen);
    return seen;
  };
}

/** A test (or one of its non-src helpers) that can start a child process. Over-
 *  matching only widens selection, so any child_process use counts. */
const SPAWN_RE = /child_process|\bexeca\b|cli-invocation|hunchCliArgs|StdioClientTransport|(?<![\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(/;

/** Entries whose import closure (edges included) keys map-entry trust. */
export const CLOSURE_ROOTS: readonly string[] = ["src/cli/index.ts", "src/mcp/server.ts", "src/cli/dna.ts"];

const PATH_TOKEN_RE = /[\w.@-]+(?:\/[\w.@-]+)+/g;
const JOIN_RE = /\b(?:join|resolve)\s*\(([^()]*)\)/g;
const LITERAL_RE = /["'`]([^"'`\n]*)["'`]/g;

/** Repo files a test's text names: path-like tokens anywhere (string literals,
 *  `--eval` import specifiers, template strings) and `join(…, "src", "x.ts")`
 *  segment runs, resolved against the REPO ROOT (and the test's own dir for
 *  `./`/`../` tokens), with `.js`→`.ts` mapping. */
export function literalRepoPaths(text: string, fromFile: string, available: Set<string>): string[] {
  const out = new Set<string>();
  const tryPath = (raw: string) => {
    const p = norm(raw);
    const bases = p.startsWith(".") ? relativeImportCandidates(fromFile, p) : [];
    const rooted = p.replace(/^(?:\.\.?\/)+/, "");
    for (const c of [...bases, rooted, rooted.replace(/\.js$/, ".ts"), rooted.replace(/\.jsx$/, ".tsx"), `${rooted}.ts`]) {
      if (available.has(c)) { out.add(c); return; }
    }
  };
  for (const m of text.matchAll(PATH_TOKEN_RE)) tryPath(m[0]);
  for (const m of text.matchAll(JOIN_RE)) {
    const segs = [...m[1]!.matchAll(LITERAL_RE)].map((l) => l[1]!).filter(Boolean);
    for (let i = 0; i < segs.length; i++) tryPath(segs.slice(i).join("/"));
  }
  return sorted(out);
}

export interface TestDependencyModel {
  /** Static imports ∪ closures of repo paths named in the test or its helpers. */
  dependencies: (testFile: string) => Set<string>;
  spawning: (testFile: string) => boolean;
  /** Text of the test plus its non-src static closure (helpers). */
  testText: (testFile: string) => string;
  /** All src/ files plus the closures of every tooling/*.mjs. */
  wholeProgram: Set<string>;
  /** Hash of the import closures (edges) of CLOSURE_ROOTS and tooling/*.mjs. */
  closureHash: string;
}

export function testDependencyModel(root: string, files: string[], graph: (file: string) => Set<string> = buildImportGraph(root, files)): TestDependencyModel {
  const available = new Set(files);
  const read = (file: string): string => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
  const helpers = (test: string): string[] => [test, ...[...graph(test)].filter((f) => available.has(f) && !f.startsWith("src/")).sort()];
  const textMemo = new Map<string, string>();
  const testText = (testFile: string): string => {
    const test = norm(testFile);
    let text = textMemo.get(test);
    if (text === undefined) textMemo.set(test, text = helpers(test).map(read).join("\n"));
    return text;
  };
  const depMemo = new Map<string, Set<string>>();
  const dependencies = (testFile: string): Set<string> => {
    const test = norm(testFile);
    const cached = depMemo.get(test);
    if (cached) return cached;
    const deps = new Set(graph(test));
    for (const file of helpers(test)) {
      for (const named of literalRepoPaths(read(file), file, available)) {
        if (named === test) continue;
        deps.add(named);
        for (const dep of graph(named)) deps.add(dep);
      }
    }
    depMemo.set(test, deps);
    return deps;
  };
  const spawning = (testFile: string): boolean => SPAWN_RE.test(testText(testFile));
  const tooling = files.filter((f) => /^tooling\/[^/]+\.mjs$/.test(f));
  const wholeProgram = new Set(files.filter((f) => f.startsWith("src/")));
  for (const t of tooling) { wholeProgram.add(t); for (const dep of graph(t)) wholeProgram.add(dep); }
  return { dependencies, spawning, testText, wholeProgram, closureHash: closureHash(root, files, graph) };
}

/** Structural hash of the entry closures: every reachable file and its direct
 *  edges. Content edits don't change it; a new import or file in the closure does. */
export function closureHash(root: string, files: string[], graph: (file: string) => Set<string> = buildImportGraph(root, files)): string {
  const available = new Set(files);
  const roots = [...CLOSURE_ROOTS.filter((f) => available.has(f)), ...files.filter((f) => /^tooling\/[^/]+\.mjs$/.test(f))];
  const reach = new Set<string>();
  for (const r of roots) { reach.add(r); for (const f of graph(r)) reach.add(f); }
  const hash = createHash("sha256");
  for (const file of sorted(reach)) {
    // Each reachable file's own closure: any added/removed edge changes one of them.
    hash.update(`${file}\0${available.has(file) ? "1" : "0"}\0${sorted(graph(file)).join("\0")}\n`);
  }
  return hash.digest("hex");
}

/** Repo files with any executed range in V8 coverage reports
 *  (`NODE_V8_COVERAGE` JSON: `{ result: [{ url, functions: [{ ranges }] }] }`). */
export function coverageFiles(reports: unknown[], root: string, repoFiles: Set<string>): string[] {
  const out = new Set<string>();
  for (const report of reports) {
    const scripts = (report as { result?: unknown })?.result;
    if (!Array.isArray(scripts)) continue;
    for (const script of scripts as { url?: unknown; functions?: { ranges?: { count?: number }[] }[] }[]) {
      if (typeof script.url !== "string" || !script.url.startsWith("file:")) continue;
      if (!script.functions?.some((f) => f.ranges?.some((r) => (r.count ?? 0) > 0))) continue;
      let abs: string;
      try { abs = fileURLToPath(script.url.replace(/[?#].*$/, "")); } catch { continue; }
      const rel = relative(root, abs);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      const file = norm(rel);
      if (repoFiles.has(file)) out.add(file);
    }
  }
  return sorted(out);
}

export type ChangeMode = { kind: "worktree" } | { kind: "staged" } | { kind: "base"; ref: string };

/** Parse `git diff --name-status -z` output; renames/copies yield both paths. */
function nameStatusPaths(out: string): string[] {
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]!;
    const n = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < n && i < parts.length; k++) paths.push(parts[i++]!);
  }
  return paths;
}

function hasHead(root: string): boolean {
  try { git(root, ["rev-parse", "--verify", "-q", "HEAD"]); return true; } catch { return false; }
}

/** Changed files for a verify run. `worktree` (default): staged + unstaged +
 *  untracked; `staged`: the index only; `base`: merge-base(ref, HEAD)..HEAD
 *  plus the working tree. */
export function changedFiles(root: string, mode: ChangeMode = { kind: "worktree" }): string[] {
  const diff = (...args: string[]) => nameStatusPaths(git(root, ["diff", "--name-status", "-z", "-M", ...args]));
  const untracked = () => git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const paths: string[] = [];
  if (mode.kind === "staged") {
    paths.push(...diff("--cached"));
  } else {
    if (mode.kind === "base") {
      const base = git(root, ["merge-base", mode.ref, "HEAD"]).trim();
      paths.push(...diff(base, "HEAD"));
    }
    if (hasHead(root)) paths.push(...diff("HEAD"));
    else paths.push(...diff("--cached"), ...diff());
    paths.push(...untracked());
  }
  return sorted(paths.map(norm));
}

/** Load an impact map; a missing file is `null`, a malformed one throws. A
 *  legacy `test: string[]` entry loads as incomplete (never trusted). */
export function loadImpactMap(path: string): ImpactMap | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; commit?: unknown; generatedAt?: unknown; closureHash?: unknown; map?: unknown };
  const commit = typeof raw?.commit === "string" ? raw.commit : "";
  const bad = () => new Error(`invalid impact map ${path}: expected { version, commit, map: { test: { files, complete, commit, closureHash } } }`);
  if (!raw?.map || typeof raw.map !== "object" || Array.isArray(raw.map)) throw bad();
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  const map: Record<string, ImpactEntry> = {};
  for (const [test, value] of Object.entries(raw.map as Record<string, unknown>)) {
    if (strings(value)) { map[norm(test)] = { files: value.map(norm), complete: false, commit, closureHash: "" }; continue; }
    const e = value as Partial<ImpactEntry> | null;
    if (!e || typeof e !== "object" || !strings(e.files)) throw bad();
    map[norm(test)] = {
      files: e.files.map(norm),
      complete: e.complete === true,
      commit: typeof e.commit === "string" ? e.commit : commit,
      closureHash: typeof e.closureHash === "string" ? e.closureHash : "",
    };
  }
  return {
    version: Number(raw.version) || 0, commit,
    ...(typeof raw.generatedAt === "string" ? { generatedAt: raw.generatedAt } : {}),
    ...(typeof raw.closureHash === "string" ? { closureHash: raw.closureHash } : {}),
    map,
  };
}
