import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** CLI options gate: every option of every command in the live Commander tree must be
 *  listed in test/cli-options-surface.json, keyed "<command path> <flag>" (root options
 *  are keyed by the bare flag), either with a test that PASSES THAT FLAG to that command
 *  or with an explicit `todo` reason. An option added without an entry (or removed while
 *  one remains) fails here, so no flag can ship without black-box coverage or a recorded
 *  reason. The flag is the option's long name (`--no-share` for a negatable option), or
 *  its short name when it has no long one.
 *
 *  "Passes that flag" is a documented heuristic over test source text, not an execution
 *  trace (the same one test/cli-surface.test.ts uses for commands, plus the flag):
 *   1. the listed test file spawns the CLI (CLI_MARKER), and
 *   2. the test block — from its title to the next test()/it()/describe() title, with
 *      comment lines removed — passes the command words as CLI arguments (see
 *      cli-surface.test.ts), and
 *   3. the same block contains the flag as a CLI token: inside a string literal, opening
 *      it (`"--flag"`, `"--flag=x"`) or after a space in it (`"serve init --flag 1"`).
 *  Known blind spot: a parent command's option is satisfied by a block that runs one of
 *  its subcommands with a same-named flag. Keep those entries honest by hand.
 *
 *  Re-seed (adds missing options, drops removed ones, keeps existing entries):
 *    HUNCH_CLI_OPTIONS_SEED=1 node tooling/run-tests.mjs test/cli-options-surface.test.ts */

interface TestRef { file: string; title: string }
type Entry = { tests: TestRef[] } | { todo: string };
interface DumpOption { long?: string; short?: string }
interface DumpCommand { name: string; options: DumpOption[]; subs: DumpCommand[] }
interface Pair { key: string; path: string; flag: string }

const ROOT = process.cwd();
const REGISTRY = join(ROOT, "test/cli-options-surface.json");
const CLI_MARKER = /hunchCliArgs|cli["'/, ]+index\.[tj]s/;
const TEST_TITLE = /\b(test|it|describe)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
const NO_TEST_TODO = "no test passes this flag to this command";

const DUMP_SCRIPT = `
const [commanderUrl, cliUrl] = process.argv.slice(2);
const { Command } = await import(commanderUrl);
Command.prototype.parseAsync = async function () {
  const walk = (c) => ({ name: c.name(), options: c.options.map((o) => ({ long: o.long, short: o.short })), subs: c.commands.map(walk) });
  process.stdout.write(JSON.stringify(walk(this)));
  process.exit(0);
};
await import(cliUrl);
`;

/** Every (command path, flag) declared in the live tree. */
function discoverPairs(): Pair[] {
  const base = tempDir("hunch-cli-options-");
  try {
    const dumpFile = join(base, "dump-tree.mjs");
    writeFileSync(dumpFile, DUMP_SCRIPT);
    const env = isolatedCliEnv({ HOME: base, USERPROFILE: base, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
    const dump = spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), dumpFile,
      import.meta.resolve("commander"), pathToFileURL(join(ROOT, "src/cli/index.ts")).href],
    { cwd: base, env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(dump.status, 0, `${dump.stdout}${dump.stderr}`);
    const pairs = new Map<string, Pair>();
    const walk = (c: DumpCommand, path: string[]) => {
      for (const o of c.options) {
        const flag = o.long ?? o.short;
        if (!flag) continue;
        const key = [...path, flag].join(" ");
        pairs.set(key, { key, path: path.join(" "), flag });
      }
      for (const s of c.subs) walk(s, [...path, s.name]);
    };
    walk(JSON.parse(dump.stdout) as DumpCommand, []);
    return [...pairs.values()].sort((a, b) => a.key.localeCompare(b.key));
  } finally {
    cleanupDir(base);
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Command words passed as CLI arguments (identical to cli-surface.test.ts). */
function invocationPattern(path: string): RegExp | null {
  if (!path) return null;
  const words = path.split(" ").map(esc);
  const q = "[\"'`]";
  const lead = "(?:[(\\[]|[\\w$)\\]]\\s*,)\\s*";
  const asArgs = words.map((w) => `${q}${w}${q}`).join("\\s*,\\s*");
  const asString = `${q}${words.join(" ")}(?=[\\s"'\`])`;
  return new RegExp(`${lead}(?:${asArgs}|${asString})`);
}

/** The flag as a CLI token inside a string literal. */
function flagPattern(flag: string): RegExp {
  return new RegExp(`(?:["'\`]|["'\`][^"'\`\\n]*\\s)${esc(flag)}(?=["'\`\\s=])`);
}

interface Block { title: string; body: string }

const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function testBlocks(text: string): Block[] {
  const starts = [...text.matchAll(TEST_TITLE)];
  return starts.flatMap((m, i) => m[1] === "describe" ? [] : [{
    title: m[3],
    body: stripComments(text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length)),
  }]);
}

function passes(body: string, pair: Pair): boolean {
  const cmd = invocationPattern(pair.path);
  return (!cmd || cmd.test(body)) && flagPattern(pair.flag).test(body);
}

const fileCache = new Map<string, string>();
function source(file: string): string {
  if (!fileCache.has(file)) fileCache.set(file, readFileSync(join(ROOT, file), "utf8"));
  return fileCache.get(file)!;
}

function testFiles(): string[] {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`);
}

/** Up to two tests per pair whose block passes the flag to the command. */
function seedFor(pair: Pair, files: string[]): Entry {
  const tests: TestRef[] = [];
  for (const file of files) {
    const text = source(file);
    if (!CLI_MARKER.test(text)) continue;
    for (const b of testBlocks(text)) {
      if (b.title.includes("${") || b.title.length < 8 || !passes(b.body, pair)) continue;
      if (text.split(b.title).length !== 2) continue; // title must identify one block
      tests.push({ file, title: b.title });
      break;
    }
    if (tests.length >= 2) break;
  }
  return tests.length ? { tests } : { todo: NO_TEST_TODO };
}

test("CLI options: every option of every command has a test that passes it, or an explicit todo", { timeout: 300_000 }, async (t) => {
  const pairs = discoverPairs();
  assert.ok(pairs.length > 300, `discovered the whole option surface (${pairs.length})`);
  let registry: Record<string, Entry> = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {};

  if (process.env.HUNCH_CLI_OPTIONS_SEED === "1") {
    const files = testFiles();
    const next: Record<string, Entry> = {};
    for (const p of pairs) {
      const kept = registry[p.key];
      next[p.key] = kept && !("todo" in kept && kept.todo === NO_TEST_TODO) ? kept : seedFor(p, files);
    }
    writeFileSync(REGISTRY, `${JSON.stringify(next, null, 2)}\n`);
    registry = next;
  }

  const discovered = pairs.map((p) => p.key);
  const missing = discovered.filter((k) => !(k in registry));
  const stale = Object.keys(registry).filter((k) => !discovered.includes(k));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] },
    `test/cli-options-surface.json is out of step with the CLI.\n` +
    (missing.length ? `  New option(s) with no entry: ${missing.join(", ")} — add a test that passes each flag to its command and list it, or a { "todo": "<reason>" }.\n` : "") +
    (stale.length ? `  Entries for option(s) that no longer exist: ${stale.join(", ")} — remove them.\n` : ""));

  const todos: string[] = [];
  const problems: string[] = [];
  for (const p of pairs) {
    const entry = registry[p.key];
    if ("todo" in entry) {
      assert.ok(typeof entry.todo === "string" && entry.todo.trim(), `${p.key}: todo needs a reason`);
      todos.push(p.key);
      await t.test(`hunch ${p.key}`, { todo: entry.todo }, () => {});
      continue;
    }
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${p.key}: needs tests[] or todo`);
    for (const ref of entry.tests) {
      const where = `${p.key} -> ${ref.file} :: "${ref.title}"`;
      if (!existsSync(join(ROOT, ref.file))) { problems.push(`${where}: file does not exist`); continue; }
      const text = source(ref.file);
      if (!text.includes(ref.title)) { problems.push(`${where}: no test with that title`); continue; }
      if (!CLI_MARKER.test(text)) { problems.push(`${where}: file never spawns the CLI`); continue; }
      if (!testBlocks(text).some((b) => b.title.includes(ref.title) && passes(b.body, p))) {
        problems.push(`${where}: test body does not pass ${p.flag} to \`${p.path || "hunch"}\``);
      }
    }
  }
  assert.deepEqual(problems, [], `cli-options-surface.json references tests that do not pass their flag:\n  ${problems.join("\n  ")}`);
  console.log(`[cli-options] ${pairs.length} (command, option) pairs: ${pairs.length - todos.length} covered, ${todos.length} todo`);
});
