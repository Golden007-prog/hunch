// Integration matrix gate: every import edge between src/ areas must be listed in
// test/integration-matrix.json with an end-to-end test (or an explicit todo reason),
// so a NEW cross-area edge without an integration test entry fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

type TestRef = { file: string; title: string };
type Entry = { tests: TestRef[]; todo?: string };
type Registry = { edges: Record<string, Entry>; externals: Record<string, Entry> };

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const REGISTRY: Registry = JSON.parse(readFileSync(join(ROOT, "test/integration-matrix.json"), "utf8"));
const EXTERNALS = ["git", "sqlite", "mcp-sdk", "http-serve", "hook-formats", "provider-clis", "embeddings", "merge-driver", "packaging", "ci-workflow"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Area = top-level dir under src/, or "root" for src/*.ts. */
function areaOf(abs: string): string {
  const parts = relative(SRC, abs).split(sep);
  return parts.length === 1 ? "root" : parts[0]!;
}

const STATIC = /^[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s*from\s*["']([^"']+)["']/gm;
const SIDE_EFFECT = /^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /(typeof\s+)?\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Runtime (non type-only) module specifiers imported by one source text. */
function runtimeSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(STATIC)) {
    if (m[2]) continue; // `import type` / `export type`
    const clause = m[3]!;
    if (clause.startsWith("{")) {
      const items = clause.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0 && items.every((s) => /^type\s/.test(s))) continue; // `{ type A, type B }`
    }
    specs.push(m[4]!);
  }
  for (const m of text.matchAll(SIDE_EFFECT)) specs.push(m[1]!);
  for (const m of text.matchAll(DYNAMIC)) if (!m[1]) specs.push(m[2]!);
  return specs;
}

function computeEdges(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (relative(SRC, target).startsWith("..")) continue;
      const from = areaOf(file), to = areaOf(target);
      if (from === to) continue;
      const key = `${from}->${to}`;
      edges.set(key, [...(edges.get(key) ?? []), `${relative(ROOT, file)} -> ${spec}`]);
    }
  }
  return edges;
}

const TITLE = /^\s*(?:test|it)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm;
const titleCache = new Map<string, string[]>();
function titlesIn(file: string): string[] {
  if (!titleCache.has(file)) titleCache.set(file, [...readFileSync(join(ROOT, file), "utf8").matchAll(TITLE)].map((m) => m[2]!));
  return titleCache.get(file)!;
}

const computed = computeEdges();

test("integration matrix: computed src area edges equal the registry edge keys exactly", () => {
  const registered = new Set(Object.keys(REGISTRY.edges));
  const problems: string[] = [];
  for (const [edge, sites] of [...computed].sort()) if (!registered.has(edge)) problems.push(`new edge ${edge} needs an integration test entry (e.g. ${sites[0]})`);
  for (const edge of [...registered].sort()) if (!computed.has(edge)) problems.push(`stale edge ${edge}: no src import crosses it any more`);
  assert.deepEqual(problems, []);
});

test("integration matrix: every required external is registered", () => {
  assert.deepEqual(EXTERNALS.filter((name) => !(name in REGISTRY.externals)), []);
});

const entries: Array<[string, Entry]> = [
  ...Object.entries(REGISTRY.edges),
  ...Object.entries(REGISTRY.externals).map(([name, entry]): [string, Entry] => [`external:${name}`, entry]),
];

test("integration matrix: every listed test file exists and contains a test with the given title", () => {
  const problems: string[] = [];
  for (const [key, entry] of entries) {
    for (const ref of entry.tests) {
      if (!existsSync(join(ROOT, ref.file))) { problems.push(`${key}: ${ref.file} does not exist`); continue; }
      if (!titlesIn(ref.file).some((t) => t.includes(ref.title))) problems.push(`${key}: no test titled "...${ref.title}..." in ${ref.file}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("integration matrix: an entry with no tests carries a non-empty todo reason", () => {
  const bad = entries.filter(([, e]) => e.tests.length === 0 && !(typeof e.todo === "string" && e.todo.trim())).map(([k]) => k);
  assert.deepEqual(bad, []);
});

// Uncovered entries are reported as node:test todos: visible in every run, never failing.
for (const [key, entry] of entries.filter(([, e]) => e.tests.length === 0)) {
  test(`integration matrix: ${key} uncovered`, { todo: entry.todo ?? "missing reason" }, () => {
    assert.fail(entry.todo ?? "uncovered");
  });
}

test("integration matrix: summary", () => {
  const rows = entries.map(([key, e]) => ({ key, status: e.tests.length > 0 ? "covered" : "todo", tests: e.tests.length }));
  const covered = rows.filter((r) => r.status === "covered").length;
  console.log(`integration matrix: ${computed.size} computed edges, ${entries.length} entries: ${covered} covered / ${rows.length - covered} todo`);
  console.table(rows);
});
