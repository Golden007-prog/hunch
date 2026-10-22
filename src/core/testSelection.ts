/** Change-scoped test selection for `hunch verify` (dec_70d82c408e). Pure
 *  selection rules over injected inputs, plus the git/filesystem readers that
 *  feed them. Fail-safe: a change nothing can attribute runs the full suite. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatchesGlob } from "./glob.js";
import { relativeImportCandidates } from "./relativeImports.js";

export interface ImpactMap {
  version: number;
  commit: string;
  /** test file → source files it exercised (repo-relative posix). */
  map: Record<string, string[]>;
}

export interface SelectionInput {
  changedFiles: string[];
  allTests: string[];
  impactMap?: ImpactMap;
  /** Transitive repo-relative imports of a test file. */
  importGraph: (testFile: string) => Set<string>;
  fullTriggers?: string[];
  /** Extra per-test globs: a changed file matching one selects that test. */
  gateMaps?: Record<string, string[]>;
}

export interface Selection {
  mode: "selected" | "full" | "none";
  tests: string[];
  reasons: Record<string, string[]>;
  fullReason?: string;
  unattributed: string[];
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

export const DOCS_ONLY_GLOBS: readonly string[] = ["**/*.md", "site/**", "docs/**"];

/** Selected tests above this share of the suite run the full suite instead. */
export const MAX_SELECTED_SHARE = 0.6;

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function selectTests(input: SelectionInput): Selection {
  const changed = sorted(input.changedFiles.map(norm));
  const allTests = sorted(input.allTests.map(norm));
  const testSet = new Set(allTests);
  const triggers = input.fullTriggers ?? DEFAULT_FULL_TRIGGERS;
  const reasons = new Map<string, Set<string>>();
  const unattributed: string[] = [];
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
    if (testSet.has(file)) { pick(file, "changed test file"); attributed = true; }
    for (const [test, globs] of Object.entries(input.gateMaps ?? {})) {
      if (globs.some((g) => pathMatchesGlob(file, g))) { pick(norm(test), `gate map covers ${file}`); attributed = true; }
    }
    if (!testSet.has(file)) {
      // The impact map can only ADD to the import graph: a stale or partial map
      // must never hide a test the static imports still attribute.
      for (const [test, srcs] of Object.entries(input.impactMap?.map ?? {})) {
        if (srcs.some((s) => norm(s) === file)) { pick(norm(test), `covers ${file} (impact map)`); attributed = true; }
      }
      for (const test of allTests) if (input.importGraph(test).has(file)) { pick(test, `imports ${file}`); attributed = true; }
    }
    if (!attributed && !DOCS_ONLY_GLOBS.some((g) => pathMatchesGlob(file, g))) unattributed.push(file);
  }

  const reasonRecord: Record<string, string[]> = {};
  for (const test of sorted(reasons.keys())) reasonRecord[test] = sorted(reasons.get(test)!);
  const selected = Object.keys(reasonRecord);
  const full = (fullReason: string): Selection => ({ mode: "full", tests: allTests, reasons: reasonRecord, fullReason, unattributed });

  if (triggerReason) return full(triggerReason);
  if (unattributed.length) {
    const more = unattributed.length > 1 ? ` (+${unattributed.length - 1} more)` : "";
    return full(`no test attributed to ${unattributed[0]}${more}`);
  }
  if (selected.length > allTests.length * MAX_SELECTED_SHARE) {
    return full(`selection too broad (${selected.length} of ${allTests.length} > ${MAX_SELECTED_SHARE * 100}%)`);
  }
  if (!selected.length) return { mode: "none", tests: [], reasons: {}, unattributed };
  return { mode: "selected", tests: selected, reasons: reasonRecord, unattributed };
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

/** Tests that launch the CLI/MCP as a subprocess reach code no static import
 *  shows. Each pattern names the entry whose import closure such a test gets. */
export const SPAWN_ENTRIES: readonly { entry: string; pattern: RegExp }[] = [
  { entry: "src/cli/index.ts", pattern: /cli-invocation|hunchCliArgs|src\/cli\/index|StdioClientTransport|\bhunch mcp\b/ },
  { entry: "src/mcp/server.ts", pattern: /StdioClientTransport|\bhunch mcp\b|hunchCliArgs\(\s*["']mcp["']/ },
];

/** Wrap an import graph so a subprocess-launching test without an impact-map
 *  entry also depends on the full closure of the entry it launches. */
export function spawnAwareGraph(
  root: string,
  graph: (file: string) => Set<string>,
  files: string[],
  impactMap?: ImpactMap,
  entries: readonly { entry: string; pattern: RegExp }[] = SPAWN_ENTRIES,
): (testFile: string) => Set<string> {
  const available = new Set(files);
  const memo = new Map<string, Set<string>>();
  return (testFile: string): Set<string> => {
    const test = norm(testFile);
    const cached = memo.get(test);
    if (cached) return cached;
    let deps = graph(test);
    if (!impactMap?.map[test]) {
      let text = "";
      try { text = readFileSync(join(root, test), "utf8"); } catch { /* unreadable → static graph only */ }
      const reached = entries.filter((e) => available.has(e.entry) && e.pattern.test(text));
      if (reached.length) {
        deps = new Set(deps);
        for (const { entry } of reached) { deps.add(entry); for (const dep of graph(entry)) deps.add(dep); }
      }
    }
    memo.set(test, deps);
    return deps;
  };
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

/** Load an impact map; a missing file is `null`, a malformed one throws. */
export function loadImpactMap(path: string): ImpactMap | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ImpactMap>;
  const map = raw?.map;
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.values(map).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string"))) {
    throw new Error(`invalid impact map ${path}: expected { version, commit, map: { test: string[] } }`);
  }
  return { version: Number(raw.version) || 0, commit: String(raw.commit ?? ""), map };
}
