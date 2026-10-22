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
  /** src/ and tooling/ files whose text names a test file by repo path. */
  testNamers?: (testFile: string) => string[];
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

/** Repo-root markdown (README.md, CHANGELOG.md, ...) is the only non-code change
 *  that can skip the full suite: it selects tests that mention it, else nothing. */
export function isDocsOnly(file: string): boolean {
  return !file.includes("/") && file.endsWith(".md");
}

/** Source the import graph can follow. Any other changed file may be read at
 *  runtime in ways no static scan sees (readdirSync walks, globs), so it runs FULL. */
const CODE_FILE_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

/** Selected tests above this share of the suite run the full suite instead. */
export const MAX_SELECTED_SHARE = 0.6;

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** A basename mention bounded by non-path characters ("d.mjs" ≠ "child.mjs"). */
const mentionRe = (name: string): RegExp => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

/** A test file by name, existing or deleted: `test/.../*.test.<ext>`. Other
 *  files under test/ are helpers and keep the code/trigger rules. */
const TEST_FILE_RE = /^test\/(?:.+\/)?[^/]+\.test\.[cm]?[jt]sx?$/;

/** A test that enumerates test files (a readdir/glob over a test directory, a
 *  generic `.test.ts` suffix) or reads the repo index: adding, deleting or
 *  editing any test file can change what it sees. Over-matching only widens. */
const META_TEST_RE = /\b(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)\s*\([^)]*test|["'`*]\.test\.[cm]?[jt]sx?\b|\.hunch[\\/"', ]+index\.json/;
export const isMetaTest = (text: string): boolean => META_TEST_RE.test(text);

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
  const nonCode: string[] = [];
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
    /** Tests a change to code file `target` reaches (graph, map, whole program). */
    const viaCode = (target: string, note: string) => {
      for (const test of allTests) {
        const entry = entries[test];
        // The map only ever ADDS: a stale or partial entry never hides a test
        // the static graph (or the whole-program rule) still attributes.
        if (entry?.files.includes(target)) { hit(test, `covers ${target} (impact map)${note}`); mapUsed.add(test); }
        if (input.importGraph(test).has(target)) hit(test, `imports ${target}${note}`);
        if (whole.has(target) && input.spawning?.(test)) {
          if (entryTrusted(entry, input.closureHash)) mapUsed.add(test);
          else hit(test, `spawns a process without a trusted impact-map entry → whole program (${target})${note}`);
        }
      }
    };
    for (const [test, globs] of Object.entries(input.gateMaps ?? {})) {
      if (globs.some((g) => pathMatchesGlob(file, g))) hit(norm(test), `gate map covers ${file}`);
    }
    if (testSet.has(file) || TEST_FILE_RE.test(file)) {
      // A changed, added or deleted test file: itself, tests that name it, tests
      // that enumerate test files, and tests reaching src/tooling that names it.
      // A deleted one nothing reads stays unattributed → FULL.
      if (testSet.has(file)) hit(file, "changed test file");
      const name = mentionRe(basename(file));
      for (const test of allTests) {
        if (test === file) continue;
        const text = input.testText?.(test) ?? "";
        if (text.includes(file) || name.test(text)) hit(test, `mentions ${file}`);
        if (isMetaTest(text)) hit(test, `enumerates test files (${file})`);
      }
      for (const namer of input.testNamers?.(file) ?? []) viaCode(norm(namer), ` (names ${file})`);
      if (!attributed) unattributed.push(file);
      continue;
    }
    if (isDocsOnly(file)) {
      for (const test of allTests) {
        const text = input.testText?.(test) ?? "";
        if (text.includes(file) || mentionRe(basename(file)).test(text)) hit(test, `mentions ${file}`);
      }
      continue;
    }
    if (!CODE_FILE_RE.test(file)) {
      nonCode.push(file);
      continue;
    }
    viaCode(file, "");
    if (!attributed) unattributed.push(file);
  }

  const reasonRecord: Record<string, string[]> = {};
  for (const test of sorted(reasons.keys())) reasonRecord[test] = sorted(reasons.get(test)!);
  const selected = Object.keys(reasonRecord);
  const used = sorted(mapUsed);
  const full = (fullReason: string): Selection => ({ mode: "full", tests: allTests, reasons: reasonRecord, fullReason, unattributed, mapUsed: used });

  if (triggerReason) return full(triggerReason);
  if (nonCode.length) {
    unattributed.unshift(...nonCode);
    const more = nonCode.length > 1 ? ` (+${nonCode.length - 1} more)` : "";
    return full(`non-code change ${nonCode[0]}${more}: runtime file reads are not traceable`);
  }
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
const JOIN_CALL_RE = /\b(?:join|resolve)\s*\(/g;

/** String-literal arguments of each `join(`/`resolve(` call, found with a
 *  balanced-paren scan so nested calls (`join(process.cwd(), "src")`) parse. */
export function joinSegmentRuns(text: string): string[][] {
  const runs: string[][] = [];
  for (const m of text.matchAll(JOIN_CALL_RE)) {
    const segs: string[] = [];
    let depth = 1;
    const stop = Math.min(text.length, m.index! + m[0].length + 4000);
    for (let i = m.index! + m[0].length; i < stop && depth > 0; i++) {
      const ch = text[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        const end = text.indexOf(ch, i + 1);
        if (end < 0) break;
        if (depth === 1 && end > i + 1) segs.push(text.slice(i + 1, end));
        i = end;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    runs.push(segs);
  }
  return runs;
}

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
    const variants = (q: string) => [q, q.replace(/\.js$/, ".ts"), q.replace(/\.jsx$/, ".tsx"), `${q}.ts`];
    // Bare src-relative names ("core/x.ts") read via `../src/${name}` resolve under src/ too.
    for (const c of [...bases, ...variants(rooted), ...variants(`src/${rooted}`)]) {
      if (available.has(c)) { out.add(c); return; }
    }
  };
  for (const m of text.matchAll(PATH_TOKEN_RE)) tryPath(m[0]);
  for (const segs of joinSegmentRuns(text)) {
    for (let i = 0; i < segs.length; i++) tryPath(segs.slice(i).join("/"));
  }
  return sorted(out);
}

/** Arguments of each `join(`/`resolve(` call: a plain string literal's value, or
 *  `null` for anything computed (identifiers, calls, `${}` templates). */
export function joinCallArgs(text: string): (string | null)[][] {
  const calls: (string | null)[][] = [];
  for (const m of text.matchAll(JOIN_CALL_RE)) {
    const args: (string | null)[] = [];
    let cur = "";
    const flush = () => {
      const t = cur.trim();
      if (t) args.push(/^(["'`])([^"'`$]*)\1$/.exec(t)?.[2] ?? null);
      cur = "";
    };
    let depth = 1;
    const stop = Math.min(text.length, m.index! + m[0].length + 4000);
    for (let i = m.index! + m[0].length; i < stop; i++) {
      const ch = text[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        const end = text.indexOf(ch, i + 1);
        if (end < 0) break;
        cur += text.slice(i, end + 1);
        i = end;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) { flush(); break; }
      else if (ch === "," && depth === 1) { flush(); continue; }
      cur += ch;
    }
    calls.push(args);
  }
  return calls;
}

const TEMPLATE_PATH_RE = /(?<![\w.@-])((?:[\w.@-]+\/)*[\w.@-]+)\/\$\{/g;
const CONCAT_PATH_RE = /["'`]([\w.@/-]+)["'`]\s*\+/g;

/** Top-level repo dirs a text reaches through a COMPUTED path: `` `../src/${p}` ``,
 *  `"src/" + p`, `join(root, "src", p)`. A test doing that may read any file
 *  under the dir, so it depends on all of them (fail closed). */
export function templatedRepoDirs(text: string, topDirs: Set<string>): string[] {
  const out = new Set<string>();
  const add = (path: string) => { for (const seg of norm(path).split("/")) if (topDirs.has(seg)) { out.add(seg); return; } };
  for (const m of text.matchAll(TEMPLATE_PATH_RE)) add(m[1]!);
  for (const m of text.matchAll(CONCAT_PATH_RE)) add(m[1]!);
  for (const args of joinCallArgs(text)) {
    args.forEach((arg, i) => { if (arg !== null && args.slice(i + 1).includes(null)) add(arg); });
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
  /** src/ and tooling/ code files whose text names a test file by repo path. */
  testNamers: (testFile: string) => string[];
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
  const topDirs = new Set(files.filter((f) => f.includes("/")).map((f) => f.slice(0, f.indexOf("/"))));
  const dependencies = (testFile: string): Set<string> => {
    const test = norm(testFile);
    const cached = depMemo.get(test);
    if (cached) return cached;
    const deps = new Set(graph(test));
    for (const file of helpers(test)) {
      const text = read(file);
      for (const named of literalRepoPaths(text, file, available)) {
        if (named === test) continue;
        deps.add(named);
        for (const dep of graph(named)) deps.add(dep);
      }
      for (const dir of templatedRepoDirs(text, topDirs)) {
        for (const f of files) if (f.startsWith(`${dir}/`) && f !== test) deps.add(f);
      }
    }
    depMemo.set(test, deps);
    return deps;
  };
  const spawning = (testFile: string): boolean => SPAWN_RE.test(testText(testFile));
  const tooling = files.filter((f) => /^tooling\/[^/]+\.mjs$/.test(f));
  const wholeProgram = new Set(files.filter((f) => f.startsWith("src/")));
  for (const t of tooling) { wholeProgram.add(t); for (const dep of graph(t)) wholeProgram.add(dep); }
  let namers: Map<string, Set<string>> | undefined;
  const testNamers = (testFile: string): string[] => {
    if (!namers) {
      namers = new Map();
      for (const file of files.filter((f) => /^(?:src|tooling)\//.test(f) && CODE_FILE.test(f))) {
        const text = read(file);
        const tokens = [...text.matchAll(PATH_TOKEN_RE)].map((m) => m[0]);
        for (const segs of joinSegmentRuns(text)) for (let i = 0; i < segs.length; i++) tokens.push(segs.slice(i).join("/"));
        for (const raw of tokens) {
          const p = norm(raw).replace(/^(?:\.\.?\/)+/, "");
          if (!p.startsWith("test/")) continue;
          let set = namers.get(p);
          if (!set) namers.set(p, set = new Set());
          set.add(file);
        }
      }
    }
    return sorted(namers.get(norm(testFile)) ?? []);
  };
  return { dependencies, spawning, testText, wholeProgram, closureHash: closureHash(root, files, graph), testNamers };
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
