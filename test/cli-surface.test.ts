import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** CLI surface gate: every command and subcommand of the live Commander tree must be
 *  listed in test/cli-surface.json, either with a test that RUNS it or with an explicit
 *  `todo` reason. A command added without a registry entry (or removed while one remains)
 *  fails here, so the CLI surface can never silently outgrow its black-box coverage.
 *
 *  "Runs it" is a documented heuristic over test source text, not an execution trace:
 *   1. the listed test file spawns the CLI somewhere (CLI_MARKER: hunchCliArgs, or a path
 *      to src/cli/index.ts / dist/cli/index.js), and
 *   2. the text of the test block — from its title to the next test()/it()/describe()
 *      title — passes the command words as CLI arguments: either as consecutive string
 *      arguments (`hunch(f, "serve", "init")`, `hunchCliArgs("serve", "init")`,
 *      `[tsx, cli, "serve", "init"]`) or as one string starting with them
 *      (`runHunch("serve init --port 1")`). The first word must open the argument
 *      list or follow a non-string argument, so `"serve", "init"` does not count for `init`.
 *  Flags placed before the command word are not recognised; list such tests by hand only
 *  if the block also matches, or keep the command `todo`.
 *
 *  Re-seed (adds missing commands, drops removed ones, keeps existing entries):
 *    HUNCH_CLI_SURFACE_SEED=1 node tooling/run-tests.mjs test/cli-surface.test.ts */

interface TestRef { file: string; title: string }
type Entry = { tests: TestRef[] } | { todo: string };
interface DumpCommand { name: string; subs: DumpCommand[] }

const ROOT = process.cwd();
const REGISTRY = join(ROOT, "test/cli-surface.json");
const CLI_MARKER = /hunchCliArgs|cli["'/, ]+index\.[tj]s/;
const TEST_TITLE = /\b(test|it|describe)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
const NO_TEST_TODO = "no test runs this command";

const DUMP_SCRIPT = `
const [commanderUrl, cliUrl] = process.argv.slice(2);
const { Command } = await import(commanderUrl);
Command.prototype.parseAsync = async function () {
  const walk = (c) => ({ name: c.name(), subs: c.commands.map(walk) });
  process.stdout.write(JSON.stringify(walk(this)));
  process.exit(0);
};
await import(cliUrl);
`;

/** Every command path in the live tree ("serve init"), root excluded. */
function discoverCommands(): string[] {
  const base = tempDir("hunch-cli-surface-");
  try {
    const dumpFile = join(base, "dump-tree.mjs");
    writeFileSync(dumpFile, DUMP_SCRIPT);
    const env = isolatedCliEnv({ HOME: base, USERPROFILE: base, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
    const dump = spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), dumpFile,
      import.meta.resolve("commander"), pathToFileURL(join(ROOT, "src/cli/index.ts")).href],
    { cwd: base, env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(dump.status, 0, `${dump.stdout}${dump.stderr}`);
    const paths: string[] = [];
    const walk = (c: DumpCommand, path: string[]) => {
      if (path.length) paths.push(path.join(" "));
      for (const s of c.subs) walk(s, [...path, s.name]);
    };
    walk(JSON.parse(dump.stdout) as DumpCommand, []);
    return paths.sort();
  } finally {
    cleanupDir(base);
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The heuristic in the header: the command words passed as CLI arguments. */
function invocationPattern(path: string): RegExp {
  const words = path.split(" ").map(esc);
  const q = "[\"'`]";
  const lead = "(?:[(\\[]|[\\w$)\\]]\\s*,)\\s*";
  const asArgs = words.map((w) => `${q}${w}${q}`).join("\\s*,\\s*");
  const asString = `${q}${words.join(" ")}(?=[\\s"'\`])`;
  return new RegExp(`${lead}(?:${asArgs}|${asString})`);
}

interface Block { title: string; body: string }

function testBlocks(text: string): Block[] {
  const starts = [...text.matchAll(TEST_TITLE)];
  return starts.flatMap((m, i) => m[1] === "describe" ? [] : [{
    title: m[3],
    body: text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length),
  }]);
}

const fileCache = new Map<string, string>();
function source(file: string): string {
  if (!fileCache.has(file)) fileCache.set(file, readFileSync(join(ROOT, file), "utf8"));
  return fileCache.get(file)!;
}

function testFiles(): string[] {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`);
}

/** Up to two tests per command whose block runs it, found by scanning test/*.test.ts. */
function seedFor(path: string, files: string[]): Entry {
  const pattern = invocationPattern(path);
  const tests: TestRef[] = [];
  for (const file of files) {
    const text = source(file);
    if (!CLI_MARKER.test(text)) continue;
    for (const b of testBlocks(text)) {
      if (b.title.includes("${") || b.title.length < 8 || !pattern.test(b.body)) continue;
      if (text.split(b.title).length !== 2) continue; // title must identify one block
      tests.push({ file, title: b.title });
      break;
    }
    if (tests.length >= 2) break;
  }
  return tests.length ? { tests } : { todo: NO_TEST_TODO };
}

test("CLI surface: every command has a test that runs it, or an explicit todo", { timeout: 300_000 }, async (t) => {
  const commands = discoverCommands();
  assert.ok(commands.length > 100, `discovered the whole command tree (${commands.length})`);
  let registry: Record<string, Entry> = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {};

  if (process.env.HUNCH_CLI_SURFACE_SEED === "1") {
    const files = testFiles();
    const next: Record<string, Entry> = {};
    for (const c of commands) {
      const kept = registry[c];
      next[c] = kept && !("todo" in kept && kept.todo === NO_TEST_TODO) ? kept : seedFor(c, files);
    }
    writeFileSync(REGISTRY, `${JSON.stringify(next, null, 2)}\n`);
    registry = next;
  }

  const keys = Object.keys(registry);
  const missing = commands.filter((c) => !(c in registry));
  const stale = keys.filter((k) => !commands.includes(k));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] },
    `test/cli-surface.json is out of step with the CLI.\n` +
    (missing.length ? `  New command(s) with no entry: ${missing.join(", ")} — add a test that runs each and list it, or a { "todo": "<reason>" }.\n` : "") +
    (stale.length ? `  Entries for command(s) that no longer exist: ${stale.join(", ")} — remove them.\n` : ""));

  const todos: string[] = [];
  const problems: string[] = [];
  for (const c of commands) {
    const entry = registry[c];
    if ("todo" in entry) {
      assert.ok(typeof entry.todo === "string" && entry.todo.trim(), `${c}: todo needs a reason`);
      todos.push(c);
      await t.test(`hunch ${c}`, { todo: entry.todo }, () => {});
      continue;
    }
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${c}: needs tests[] or todo`);
    const pattern = invocationPattern(c);
    for (const ref of entry.tests) {
      const where = `${c} -> ${ref.file} :: "${ref.title}"`;
      if (!existsSync(join(ROOT, ref.file))) { problems.push(`${where}: file does not exist`); continue; }
      const text = source(ref.file);
      if (!text.includes(ref.title)) { problems.push(`${where}: no test with that title`); continue; }
      if (!CLI_MARKER.test(text)) { problems.push(`${where}: file never spawns the CLI`); continue; }
      const runs = testBlocks(text).some((b) => b.title.includes(ref.title) && pattern.test(b.body));
      if (!runs) problems.push(`${where}: test body does not invoke the command (pattern ${pattern})`);
    }
  }
  assert.deepEqual(problems, [], `cli-surface.json references tests that do not run their command:\n  ${problems.join("\n  ")}`);
  console.log(`[cli-surface] ${commands.length} commands: ${commands.length - todos.length} covered, ${todos.length} todo`);
  if (todos.length) console.log(`[cli-surface] todo: ${todos.join(", ")}`);
});
