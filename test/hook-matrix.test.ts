import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
/**
 * Hook matrix: every assistant hook works end to end, and a new provider or a
 * new hook event without a row here fails CI.
 *
 * One temp repo after `hunch init --all-assistants`, a decision + blocking
 * constraint seeded on src/api/orders.ts. The provider×event table is DISCOVERED
 * from the hook configs init wrote and must equal EXPECTED below. Each cell then
 * runs the real `hunch hook --provider <p>` with a payload in that host's native
 * shape; robustness inputs and an opted-out repo must stay silent; and every
 * installed config command string is executed through the shell. No network:
 * deterministic synthesis, npm offline, isolated HOME/TEMP.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { HOOK_PROVIDERS, type HookProvider } from "../src/core/agenthook.js";
import { readHookObservations } from "../src/core/hookObservations.js";
import { hunchCliArgs } from "./cli-invocation.js";

/** provider → native hook events Hunch installs. A new provider or event must be added here. */
const EXPECTED: Record<HookProvider, string[]> = {
  claude: ["PreToolUse", "UserPromptSubmit", "SessionStart", "SubagentStart", "PreCompact", "PostToolUse", "PostToolUseFailure", "Stop"],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact", "SubagentStart"],
  vscode: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  cursor: ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "stop"],
  windsurf: ["pre_user_prompt", "pre_write_code", "post_write_code", "post_run_command"],
  antigravity: ["PreInvocation", "PreToolUse", "Stop"],
};

/** Native event → Hunch's internal event (what hook observations record). */
const NORMALIZED: Record<string, string> = {
  sessionStart: "SessionStart", beforeSubmitPrompt: "UserPromptSubmit", preToolUse: "PreToolUse", postToolUse: "PostToolUse", stop: "Stop",
  pre_user_prompt: "UserPromptSubmit", pre_write_code: "PreToolUse", post_write_code: "PostToolUse", post_run_command: "PostToolUse",
  PreInvocation: "SessionStart",
};
const normalized = (event: string): string => NORMALIZED[event] ?? event;

const NOW = new Date(Date.now() - 86_400_000).toISOString();
const CON_STATEMENT = "API handlers must route persistence through OrderService";
const FILE = "src/api/orders.ts";
const PROJECT_ROOT = process.cwd();
const RUN = Math.random().toString(36).slice(2, 8);

interface Run { status: number | null; stdout: string; stderr: string }
let sandbox = "";
let root = "";
let env: NodeJS.ProcessEnv = {};
/** Windsurf's documented payload names its event in `agent_action_name` and carries
 * prompt/command in `tool_info`; failures are collected here and asserted below. */
const windsurfFailures: string[] = [];

function hunch(args: string[], input?: string, cwd = root): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd, env, input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function ok(args: string[]): Run {
  const r = hunch(args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}
function initGitRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "matrix@example.com");
  git(dir, "config", "user.name", "Hook Matrix");
  git(dir, "config", "commit.gpgsign", "false");
}

/** A realistic native payload for `provider`'s `event` (unique session per cell). */
function payload(provider: HookProvider, event: string): Record<string, unknown> {
  const abs = join(root, FILE);
  const sid = `${provider}-${event}-${RUN}`;
  const patch = `*** Begin Patch\n*** Update File: ${FILE}\n@@\n-export const orders = 1;\n+export const orders = 2;\n*** End Patch\n`;
  switch (provider) {
    case "claude": {
      const base = { session_id: sid, transcript_path: join(sandbox, "t.jsonl"), cwd: root, permission_mode: "default", hook_event_name: event };
      const edit = { tool_name: "Edit", tool_input: { file_path: abs, old_string: "orders = 1", new_string: "orders = 2" } };
      switch (event) {
        case "SessionStart": return { ...base, source: "startup" };
        case "UserPromptSubmit": return { ...base, prompt_id: `p-${RUN}`, prompt: "Refactor the orders API handler" };
        case "PreToolUse": return { ...base, ...edit };
        case "PostToolUse": return { ...base, ...edit, tool_response: { filePath: abs, success: true } };
        case "PostToolUseFailure": return { ...base, tool_name: "Bash", tool_input: { command: "npm test" }, error: "Command failed with exit code 1" };
        case "SubagentStart": return { ...base, agent_id: `a-${RUN}`, agent_type: "general-purpose" };
        case "PreCompact": return { ...base, trigger: "auto", custom_instructions: "" };
        case "Stop": return { ...base, stop_hook_active: false };
      }
      break;
    }
    case "codex": {
      const base = { session_id: sid, turn_id: `t-${RUN}`, cwd: root, model: "gpt-5", hook_event_name: event };
      switch (event) {
        case "SessionStart": return { ...base, source: "startup" };
        case "UserPromptSubmit": return { ...base, prompt: "Refactor the orders API handler" };
        case "PreToolUse": return { ...base, tool_name: "apply_patch", tool_input: { input: patch } };
        case "PostToolUse": return { ...base, tool_name: "apply_patch", tool_input: { input: patch }, tool_response: { success: true, output: "Done" } };
        case "SubagentStart": return { ...base, agent_id: `a-${RUN}`, agent_type: "worker" };
        case "PreCompact": return { ...base, trigger: "auto" };
        case "Stop": return { ...base, stop_hook_active: false };
      }
      break;
    }
    case "vscode": {
      const base = { hookEventName: event, sessionId: sid, timestamp: NOW, cwd: root };
      const edit = { tool_name: "replace_string_in_file", tool_input: { filePath: abs, oldString: "orders = 1", newString: "orders = 2" } };
      switch (event) {
        case "SessionStart": return { ...base, source: "new" };
        case "UserPromptSubmit": return { ...base, prompt: "Refactor the orders API handler" };
        case "PreToolUse": return { ...base, ...edit };
        case "PostToolUse": return { ...base, ...edit, tool_response: "ok" };
        case "Stop": return { ...base, stop_hook_active: false };
      }
      break;
    }
    case "cursor": {
      const base = { hook_event_name: event, conversation_id: sid, generation_id: `g-${RUN}`, workspace_roots: [root] };
      const edit = { tool_name: "Write", tool_input: { file_path: abs, content: "export const orders = 2;\n" } };
      switch (event) {
        case "sessionStart": return base;
        case "beforeSubmitPrompt": return { ...base, prompt: "Refactor the orders API handler", attachments: [] };
        case "preToolUse": return { ...base, ...edit };
        case "postToolUse": return { ...base, ...edit, tool_output: "ok" };
        case "stop": return { ...base, status: "completed" };
      }
      break;
    }
    case "windsurf": {
      // Documented Cascade hook shape: the event name arrives as agent_action_name.
      const base = { agent_action_name: event, trajectory_id: sid, execution_id: `e-${RUN}`, timestamp: NOW };
      switch (event) {
        case "pre_user_prompt": return { ...base, tool_info: { user_prompt: "Refactor the orders API handler" } };
        case "pre_write_code":
        case "post_write_code": return { ...base, tool_info: { file_path: abs, edits: [{ old_string: "orders = 1", new_string: "orders = 2" }] } };
        case "post_run_command": return { ...base, tool_info: { command_line: "npm test", cwd: root } };
      }
      break;
    }
    case "antigravity": {
      switch (event) {
        case "PreInvocation": return { conversationId: sid, invocationNum: 0 };
        case "PreToolUse": return { conversationId: sid, toolCall: { name: "replace_file_content", args: { TargetFile: abs, ReplacementContent: "export const orders = 2;" } } };
        case "Stop": return { conversationId: sid, executionNum: 1 };
      }
      break;
    }
  }
  throw new Error(`no native payload for ${provider}:${event} — add one`);
}

/** Parse stdout in the host's dialect; returns delivered context text (or null). */
function hostOutput(provider: HookProvider, event: string, stdout: string): { json: Record<string, unknown> | null; context: string | null } {
  const text = stdout.trim();
  if (!text) return { json: null, context: null };
  const json = JSON.parse(text) as Record<string, unknown>;
  assert.ok(json && typeof json === "object" && !Array.isArray(json), `${provider}:${event} stdout must be one JSON object`);
  const keys = Object.keys(json);
  const allowed: Record<HookProvider, string[]> = {
    claude: ["hookSpecificOutput", "systemMessage", "decision", "reason", "continue", "stopReason"],
    codex: ["hookSpecificOutput", "systemMessage", "decision", "reason", "continue", "stopReason"],
    vscode: ["hookSpecificOutput", "systemMessage", "decision", "reason", "continue", "stopReason"],
    cursor: ["permission", "agent_message", "user_message", "followup_message"],
    windsurf: [],
    antigravity: ["injectSteps", "decision", "reason"],
  };
  assert.deepEqual(keys.filter((k) => !allowed[provider].includes(k)), [], `${provider}:${event} emitted keys outside its dialect: ${text.slice(0, 300)}`);
  const hso = json.hookSpecificOutput as Record<string, unknown> | undefined;
  if (hso) assert.equal(hso.hookEventName, normalized(event), `${provider}:${event} hookEventName`);
  const steps = json.injectSteps as Array<{ ephemeralMessage?: string }> | undefined;
  const context = provider === "cursor" ? (json.agent_message as string | undefined)
    : provider === "antigravity" ? steps?.[0]?.ephemeralMessage
    : hso?.additionalContext as string | undefined;
  return { json, context: context ?? null };
}

/** Every (provider, native event, command) Hunch wrote into a JSON hook config under `dir`. */
function discoverHooks(dir: string): Array<{ file: string; provider: string; event: string; command: string }> {
  const found: Array<{ file: string; provider: string; event: string; command: string }> = [];
  const commandsOf = (entry: unknown): string[] => {
    const e = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!e) return [];
    const own = typeof e.command === "string" ? [e.command] : [];
    return [...own, ...(Array.isArray(e.hooks) ? e.hooks.flatMap(commandsOf) : [])];
  };
  const visit = (file: string, node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const command of value.flatMap(commandsOf)) {
          if (!/\shook(\s|$)/.test(command)) continue;
          found.push({ file, event: key, command, provider: /--provider\s+"?([a-z]+)/.exec(command)?.[1] ?? "claude" });
        }
      } else visit(file, value);
    }
  };
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if ([".git", ".hunch", ".hunch-cache", "node_modules"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        try { visit(relative(dir, p).replace(/\\/g, "/"), JSON.parse(readFileSync(p, "utf8"))); } catch { /* not a config */ }
      }
    }
  };
  walk(dir);
  return found;
}

before(() => {
  sandbox = tempDir("hunch-hook-matrix-");
  root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  const tmp = join(sandbox, "tmp");
  for (const d of [root, home, tmp]) mkdirSync(d, { recursive: true });
  const path = process.env.PATH ?? process.env.Path ?? "";
  env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", HUNCH_SYNTH_PROVIDER: "deterministic",
    NO_COLOR: "1", CI: "1", npm_config_offline: "true",
    PATH: `${join(PROJECT_ROOT, "node_modules", ".bin")}${delimiter}${path}`,
  });
  delete env.Path;
  initGitRepo(root);
  mkdirSync(join(root, "src", "api"), { recursive: true });
  writeFileSync(join(root, FILE), "export const orders = 1;\nexport function listOrders() { return orders; }\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  ok(["init", "--all-assistants"]);
  const dec = {
    id: "dec_a1b2c3d4e5", title: "Orders API goes through OrderService", topic: "orders.api-boundary", status: "accepted",
    context: "Direct DB access from handlers caused an N+1 incident.", decision: "Handlers call OrderService.",
    consequences: ["Handlers stay thin."], alternatives_rejected: ["Direct database access from handlers."], rejected_tripwires: [],
    related_components: [], related_files: [FILE], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: NOW, valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-1"] }, date: NOW,
  };
  const con = {
    id: "con_a1b2c3d4e5", type: "architecture", statement: CON_STATEMENT, scope: ["src/api/**"], severity: "blocking",
    enforcement: "advisory_v1", match: null, forbids: null, rationale: "service boundary", source_decision: dec.id,
    violations: [], status: "active", valid_from: NOW, valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-1"] },
  };
  for (const [kind, rec] of [["decisions", dec], ["constraints", con]] as const) {
    mkdirSync(join(root, ".hunch", kind), { recursive: true });
    writeFileSync(join(root, ".hunch", kind, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  }
  ok(["index"]);
});
after(() => { if (sandbox) cleanupDir(sandbox); });

describe("hook matrix", () => {
  test("discovered provider×event table equals EXPECTED", () => {
    assert.deepEqual([...HOOK_PROVIDERS].sort(), Object.keys(EXPECTED).sort(), "HOOK_PROVIDERS changed: add the provider to EXPECTED");
    const table: Record<string, string[]> = {};
    for (const h of discoverHooks(root)) (table[h.provider] ??= []).includes(h.event) || table[h.provider]!.push(h.event);
    const sorted = (t: Record<string, string[]>) => Object.fromEntries(Object.entries(t).sort().map(([k, v]) => [k, [...v].sort()]));
    assert.deepEqual(sorted(table), sorted(EXPECTED));
  });

  test("every provider×event runs the real CLI with a native payload", { timeout: 300_000 }, () => {
    const failures: string[] = [];
    for (const provider of HOOK_PROVIDERS) {
      for (const event of EXPECTED[provider]) {
        const cell = `${provider}:${event}`;
        const r = hunch(["hook", "--provider", provider], JSON.stringify(payload(provider, event)));
        if (r.status !== 0) { failures.push(`${cell} exit ${r.status}: ${r.stderr.slice(0, 300)}`); continue; }
        let out: ReturnType<typeof hostOutput>;
        try { out = hostOutput(provider, event, r.stdout); } catch (e) { failures.push(`${cell} bad output: ${(e as Error).message}`); continue; }
        if (/grounding unavailable/.test(out.context ?? "")) failures.push(`${cell} hook errored: ${out.context}`);
        if (provider === "windsurf" && r.stdout.trim()) failures.push(`${cell} windsurf has no context channel, got ${r.stdout.slice(0, 200)}`);
        const n = normalized(event);
        const delivers = provider !== "windsurf" && !(provider === "antigravity" && n !== "SessionStart");
        const want = !delivers ? null
          : n === "SessionStart" ? /Hunch orientation/
          : n === "PreToolUse" ? new RegExp(CON_STATEMENT)
          : n === "UserPromptSubmit" ? /hunch/i
          : n === "SubagentStart" ? new RegExp(CON_STATEMENT)
          : null;
        if (want && !want.test(out.context ?? "")) failures.push(`${cell} missing ${want}: stdout=${r.stdout.slice(0, 300) || "<empty>"}`);
      }
    }
    // The host's delivery was recognized: one observation per provider × internal event.
    const seen = new Set(readHookObservations(root).map((o) => `${o.provider}:${o.event}`));
    for (const provider of HOOK_PROVIDERS) {
      for (const event of EXPECTED[provider]) {
        if (!seen.has(`${provider}:${normalized(event)}`)) failures.push(`${provider}:${event} not recognized (no hook observation for ${normalized(event)})`);
      }
    }
    windsurfFailures.push(...failures.filter((f) => f.startsWith("windsurf:")));
    assert.deepEqual([...new Set(failures.filter((f) => !f.startsWith("windsurf:")))], []);
  });

  test("windsurf native payloads are recognized end to end", () => {
    assert.deepEqual(windsurfFailures, []);
  });

  test("robustness: empty, garbage, wrong-shape and 1 MB input exit 0 silently", { timeout: 300_000 }, () => {
    const junk = "x".repeat(1024 * 1024);
    const inputs: Array<[string, string]> = [
      ["empty", ""],
      ["garbage", "{not json"],
      ["array", "[1,2,3]"],
      ["wrong-shape", JSON.stringify({ hook_event_name: 42, tool_input: "x", event: { nested: true } })],
      ["huge", JSON.stringify({ hook_event_name: "NotAnEvent", junk })],
    ];
    const failures: string[] = [];
    for (const provider of HOOK_PROVIDERS) {
      for (const [label, input] of inputs) {
        const r = hunch(["hook", "--provider", provider], input);
        if (r.status !== 0 || r.stdout.trim()) failures.push(`${provider}/${label}: exit ${r.status} stdout=${r.stdout.slice(0, 200)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("opted-out repo (.hunch-removed): every provider exits 0 silently", { timeout: 300_000 }, () => {
    const out = join(sandbox, "optout");
    mkdirSync(out, { recursive: true });
    initGitRepo(out);
    writeFileSync(join(out, ".hunch-removed"), "removed\n");
    const failures: string[] = [];
    for (const provider of HOOK_PROVIDERS) {
      const event = EXPECTED[provider][0]!;
      const r = hunch(["hook", "--provider", provider], JSON.stringify({ ...payload(provider, event), cwd: out }), out);
      if (r.status !== 0 || r.stdout.trim() || r.stderr.trim()) failures.push(`${provider}: exit ${r.status} stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
    }
    assert.deepEqual(failures, []);
  });

  test("every installed hook config command launches hunch through the shell", { timeout: 300_000 }, () => {
    const hooks = discoverHooks(root);
    // One run per distinct (provider, command): the event key does not change what is launched.
    const unique = new Map<string, { file: string; provider: string; event: string; command: string }>();
    for (const h of hooks) if (!unique.has(`${h.provider}\n${h.command}`)) unique.set(`${h.provider}\n${h.command}`, h);
    assert.ok(unique.size >= HOOK_PROVIDERS.length, "every provider has an installed command");
    // PowerShell is not exercised: whether npx.ps1 may run depends on the machine's
    // execution policy, not on what Hunch wrote.
    const shells: Array<[string, string, string[]]> = process.platform === "win32"
      ? [["cmd", process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c"]]]
      : [["sh", "/bin/sh", ["-c"]]];
    const failures: string[] = [];
    for (const h of unique.values()) {
      const provider = h.provider as HookProvider;
      const event = EXPECTED[provider][0]!;
      for (const [label, shell, flags] of shells) {
        const beforeAt = readHookObservations(root).find((o) => o.provider === provider && o.event === normalized(event))?.at ?? "";
        const r = spawnSync(shell, [...flags, label === "cmd" ? `"${h.command}"` : h.command], {
          cwd: root, env, input: JSON.stringify(payload(provider, event)), encoding: "utf8", timeout: 120_000, windowsVerbatimArguments: label === "cmd",
        });
        const afterAt = readHookObservations(root).find((o) => o.provider === provider && o.event === normalized(event))?.at ?? "";
        if (r.status !== 0) failures.push(`${h.file} ${h.event} via ${label}: exit ${r.status} ${String(r.stderr).slice(0, 300)}`);
        else if (!(afterAt > beforeAt)) failures.push(`${h.file} ${h.event} via ${label}: exit 0 but hunch never handled the event (${h.command})`);
      }
    }
    windsurfFailures.push(...failures.filter((f) => f.startsWith(".windsurf/")));
    assert.deepEqual(failures.filter((f) => !f.startsWith(".windsurf/")), []);
  });

  test("windsurf installed command is handled when launched", () => {
    assert.deepEqual(windsurfFailures.filter((f) => f.startsWith(".windsurf/")), []);
  });
});
