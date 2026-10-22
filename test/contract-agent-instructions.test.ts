import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { HOOK_REMINDER } from "../src/core/hookText.js";
import type { Decision } from "../src/core/types.js";
import { renderHunchSection } from "../src/integrations/claudemd.js";
import { writeSlashCommands } from "../src/integrations/scaffold.js";
import { buildServer, MCP_INSTRUCTIONS } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
// The contract covers every tool an agent can be told about, including the specialist groups
// the everyday default hides (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

/**
 * Contract: everything Hunch's agent-facing text tells an agent to call must exist and work.
 * Bug class: every delivered brief line said `hunch_why("<record id>")` while hunch_why only
 * accepted paths (#474). Sources are the real producers, never copies of their text.
 */

const execFileAsync = promisify(execFile);
const CLI = resolve("src/cli/index.ts");

const DECISION_ID = "dec_c0a7ac7001";
const CONSTRAINT_ID = "con_c0a7ac7002";
const TOPIC = "auth.session-transport";
const FILE = "src/auth/session.ts";

function decision(): Decision {
  const now = "2026-07-19T12:00:00.000Z";
  return {
    id: DECISION_ID,
    title: "Sessions travel in signed cookies",
    topic: TOPIC,
    status: "accepted",
    context: "Session tokens must survive page reloads without exposing them to scripts.",
    decision: "Session tokens are carried in signed httpOnly cookies, verified in verifySession.",
    consequences: [],
    alternatives_rejected: ["Bearer tokens in localStorage."],
    rejected_tripwires: [],
    related_components: [],
    related_files: [FILE],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: now,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review:session-transport"] },
    date: now,
  };
}

function fixture(decisionId = DECISION_ID): string {
  const root = tempDir("hunch-contract-instr-");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  writeFileSync(join(root, FILE), "export function verifySession(token: string) { return token.length > 0; }\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", { ...decision(), id: decisionId });
  store.json.put("constraints", mkConstraint({
    id: CONSTRAINT_ID,
    statement: "Session verification never trusts an unsigned token.",
    scope: ["src/auth/**"],
    severity: "blocking",
    rationale: "An unsigned token lets any client impersonate any user.",
  }));
  store.reindex();
  store.close();
  return root;
}

/** One Claude hook event through the real CLI; returns every string the hook printed. */
function hookText(root: string, event: Record<string, unknown>): string {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), CLI, "hook", "--provider", "claude"], {
    cwd: root,
    env: isolatedCliEnv({ HUNCH_PIPELINE: "0", TMPDIR: tmp, TMP: tmp, TEMP: tmp }),
    input: JSON.stringify({ cwd: root, session_id: `contract-${process.pid}`, ...event }),
    encoding: "utf8",
  }).trim();
  return out ? collectStrings(JSON.parse(out)).join("\n") : "";
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function textOf(result: { content?: unknown }): string {
  const items = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  return items.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

/** Commander help lists commands two spaces in, `name|alias [args]  description`. */
function commandsFromHelp(help: string): Set<string> {
  const names = new Set<string>();
  const section = help.split(/^Commands:\s*$/m)[1] ?? "";
  for (const line of section.split(/\r?\n/)) {
    const m = /^ {2}([a-z][\w-]*)((?:\|[\w-]+)*)/.exec(line);
    if (!m) continue;
    names.add(m[1]!);
    for (const alias of m[2]!.split("|").filter(Boolean)) names.add(alias);
  }
  return names;
}

async function cliHelp(path: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, hunchCliArgs(...path, "--help"), {
    env: isolatedCliEnv({ COLUMNS: "200" }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

interface Source { name: string; text: string }

/** `hunch_<name>` tokens; a trailing underscore (`hunch_record_*`) is a prefix reference. */
function toolRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/\bhunch_[a-z0-9_]+/g)].map((m) => m[0]))];
}

/** `hunch <subcommand> [<sub-subcommand>]` in code-ish position: not part of a path,
 *  package name, flag, or the capitalized product name. */
function cliRefs(text: string): Array<{ ref: string; words: string[] }> {
  const refs = new Map<string, string[]>();
  for (const m of text.matchAll(/(?<![\w./@\-])hunch ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
    const words = [m[1]!, ...(m[2] ? [m[2]] : [])];
    refs.set(m[0], words);
  }
  return [...refs].map(([ref, words]) => ({ ref, words }));
}

test("every tool and CLI command Hunch's agent-facing text names exists, and the advertised call shapes work", async (t) => {
  const root = fixture();
  const scaffoldRoot = tempDir("hunch-contract-scaffold-");
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-agent-instructions", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(scaffoldRoot);
    cleanupDir(root);
  });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  // ---- 1. Collect agent-facing text from the real producers. ----
  const sources: Source[] = [{ name: "MCP_INSTRUCTIONS", text: MCP_INSTRUCTIONS }, { name: "HOOK_REMINDER", text: HOOK_REMINDER }];

  const listed = await client.listTools();
  const registered = new Set(listed.tools.map((tool) => tool.name));
  for (const tool of listed.tools) {
    sources.push({ name: `tool description: ${tool.name}`, text: tool.description ?? "" });
    const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const [param, schema] of Object.entries(props)) {
      if (schema.description) sources.push({ name: `tool param: ${tool.name}.${param}`, text: schema.description });
    }
  }

  const groundingStore = new HunchStore(hunchPaths(root));
  try {
    sources.push({ name: "grounding block (renderHunchSection)", text: renderHunchSection(groundingStore, root) });
  } finally {
    groundingStore.close();
  }

  const { written } = writeSlashCommands(scaffoldRoot);
  assert.ok(written.length > 0, "slash commands are scaffolded");
  for (const file of written) sources.push({ name: `slash command: ${file.split(/[\\/]/).pop()}`, text: readFileSync(file, "utf8") });

  const contextResult = await call("hunch_context", { target: FILE });
  sources.push({ name: `hunch_context("${FILE}") brief`, text: textOf(contextResult) });

  const hookEvents: Array<[string, Record<string, unknown>]> = [
    ["SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    ["UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: `Change how ${FILE} verifies the session transport` }],
    ["PreToolUse Edit", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Edit", tool_input: { file_path: join(root, FILE), old_string: "token.length > 0", new_string: "token.length > 1" } }],
    ["SubagentStart general", { hook_event_name: "SubagentStart", agent_type: "general-purpose" }],
    ["SubagentStart Explore", { hook_event_name: "SubagentStart", agent_type: "Explore" }],
    ["SubagentStart Plan", { hook_event_name: "SubagentStart", agent_type: "Plan" }],
  ];
  for (const [name, event] of hookEvents) sources.push({ name: `hook: ${name}`, text: hookText(root, event) });

  // Each producer must actually have produced text, or the contract below checks nothing.
  for (const source of sources) {
    if (source.name.startsWith("tool param:") || source.name.startsWith("tool description:")) continue;
    assert.ok(source.text.trim().length > 0, `${source.name} produced agent-facing text`);
  }

  // ---- 2a. Every hunch_<name> reference is a registered tool. ----
  const toolFailures: string[] = [];
  let toolRefCount = 0;
  for (const source of sources) {
    for (const ref of toolRefs(source.text)) {
      toolRefCount++;
      const ok = ref.endsWith("_") ? [...registered].some((name) => name.startsWith(ref)) : registered.has(ref);
      if (!ok) toolFailures.push(`${source.name}: names \`${ref}\`, which tools/list does not register`);
    }
  }
  assert.ok(toolRefCount > 20, `expected a meaningful number of tool references, found ${toolRefCount}`);
  assert.deepEqual(toolFailures, [], `agent-facing text names unregistered tools:\n${toolFailures.join("\n")}`);

  // ---- 2b. Every `hunch <subcommand>` reference is a real Commander command. ----
  const topLevel = commandsFromHelp(await cliHelp([]));
  assert.ok(topLevel.has("init") && topLevel.has("hook"), `parsed the top-level command list (${[...topLevel].join(", ")})`);
  const allCli = sources.flatMap((source) => cliRefs(source.text).map((ref) => ({ source: source.name, ...ref })));
  const referencedTop = [...new Set(allCli.map((r) => r.words[0]!).filter((w) => topLevel.has(w)))];
  const subcommands = new Map<string, Set<string>>(
    await Promise.all(referencedTop.map(async (cmd) => [cmd, commandsFromHelp(await cliHelp([cmd]))] as [string, Set<string>])),
  );
  const cliFailures: string[] = [];
  for (const { source, ref, words } of allCli) {
    const [cmd, sub] = words;
    if (!topLevel.has(cmd!)) {
      cliFailures.push(`${source}: names \`${ref}\`, but \`hunch ${cmd}\` is not a CLI command`);
      continue;
    }
    const subs = subcommands.get(cmd!)!;
    // A command with subcommands must be followed by one of them when a lowercase word follows;
    // a command without subcommands takes the next word as prose or an argument.
    if (sub && subs.size > 0 && !subs.has(sub)) {
      cliFailures.push(`${source}: names \`${ref}\`, but \`hunch ${cmd}\` has no \`${sub}\` subcommand (${[...subs].join(", ")})`);
    }
  }
  assert.ok(allCli.length > 0, "agent-facing text references at least one CLI command");
  t.diagnostic(`${sources.length} sources; ${toolRefCount} tool refs; ${allCli.length} CLI refs (${[...new Set(allCli.map((r) => r.ref))].join(", ")})`);
  assert.deepEqual(cliFailures, [], `agent-facing text names CLI commands that do not exist:\n${cliFailures.join("\n")}`);

  // ---- 3. The advertised call shapes answer with real fixture ids. ----
  const allText = sources.map((s) => s.text).join("\n");
  assert.match(allText, /hunch_why\("dec_/, "a delivered brief line advertises hunch_why(\"<decision id>\")");
  assert.match(allText, /hunch_why\("con_/, "a delivered brief line advertises hunch_why(\"<constraint id>\")");
  assert.match(allText, /hunch_current_decision\(topic\)/, "the text advertises hunch_current_decision(topic)");

  const answers = (label: string, result: { isError?: unknown; content?: unknown }, mustMention: string) => {
    const text = textOf(result);
    assert.ok(!result.isError, `${label} returned an error: ${text.slice(0, 300)}`);
    assert.ok(text.trim().length > 0, `${label} returned nothing`);
    assert.doesNotMatch(text, /\bNo (recorded|records?|current decision|decision history|decisions?|rationale|match(es)?)\b/i, `${label} answered "no record": ${text.slice(0, 300)}`);
    assert.ok(text.includes(mustMention), `${label} does not mention ${mustMention}: ${text.slice(0, 300)}`);
  };
  answers(`hunch_why("${DECISION_ID}")`, await call("hunch_why", { target: DECISION_ID }), DECISION_ID);
  answers(`hunch_why("${CONSTRAINT_ID}")`, await call("hunch_why", { target: CONSTRAINT_ID }), CONSTRAINT_ID);
  answers(`hunch_why("${FILE}")`, await call("hunch_why", { target: FILE }), DECISION_ID);
  answers(`hunch_context("${FILE}")`, contextResult, CONSTRAINT_ID);
  answers(`hunch_context(task phrase)`, await call("hunch_context", { target: "session transport cookies" }), DECISION_ID);
  answers(`hunch_current_decision("${TOPIC}")`, await call("hunch_current_decision", { topic: TOPIC }), DECISION_ID);
  answers(`hunch_check_constraints("${FILE}")`, await call("hunch_check_constraints", { scope: FILE }), CONSTRAINT_ID);

  // Every record id a brief line tells the agent to drill into must resolve through that call.
  const advertisedIds = [...new Set([...allText.matchAll(/hunch_why\("((?:dec|con|bug|fnd)_[A-Za-z0-9_]+)"\)/g)].map((m) => m[1]!))];
  for (const id of advertisedIds) answers(`hunch_why("${id}") as advertised`, await call("hunch_why", { target: id }), id);
});

// Brief lines advertise `hunch_why("<id>")` for ANY stored id; the schema accepts any id
// string (hand-authored, imported), so a non-hex id must resolve too.
test("hunch_why resolves every id a brief line advertises, including a non-hex stored id", async (t) => {
  const root = fixture("dec_session_transport");
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-nonhex", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });
  const brief = textOf(await client.callTool({ name: "hunch_context", arguments: { target: FILE } }));
  assert.match(brief, /hunch_why\("dec_session_transport"\)/, "the brief advertises the drill-down call");
  const why = await client.callTool({ name: "hunch_why", arguments: { target: "dec_session_transport" } });
  const text = textOf(why);
  assert.ok(!why.isError, text);
  assert.doesNotMatch(text, /\bNo recorded\b/, `hunch_why("dec_session_transport") answered no record: ${text}`);
});
