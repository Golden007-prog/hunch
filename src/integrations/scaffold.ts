/**
 * Writes the two remaining Claude Code integration surfaces (DESIGN.md §7):
 *   - .mcp.json          → registers the `hunch` MCP server with Claude Code
 *   - .claude/commands/* → user-triggered slash commands for the §5 workflows
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Invocation {
  command: string;
  args: string[]; // args BEFORE the subcommand (e.g. ["/abs/dist/cli/index.js"])
}

/** Merge a `hunch` server entry into .mcp.json, preserving other servers. */
export function writeMcpJson(root: string, inv: Invocation): string {
  const file = join(root, ".mcp.json");
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      json = {};
    }
  }
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  return file;
}

const WHY_CMD = `---
description: Explain why a file or symbol is the way it is, from Hunch
---
Use the \`hunch_why\` MCP tool on **$ARGUMENTS** (a file path or symbol name).

Then summarize, with citations:
- the **decisions** that shaped it (id + rationale),
- the **constraints** that must not break,
- the **bug history** behind it (root causes).

Cite record ids and their provenance/confidence. If Hunch returns nothing,
say so plainly and suggest running \`hunch index\` or \`hunch backfill\`.
`;

const FIX_CMD = `---
description: Fix a bug grounded in Hunch (past root causes, constraints, blast radius)
---
We are fixing: **$ARGUMENTS**

Follow the Hunch-grounded workflow (DESIGN §5) — do NOT skip the memory lookups:
1. \`hunch_bug_lineage("$ARGUMENTS")\` — has this class of bug happened before? what was the root cause and the fix?
2. Identify the suspect symbol/file, then \`hunch_get_dependents(<symbol>)\` to learn the blast radius.
3. \`hunch_check_constraints(<scope>)\` — list invariants you must preserve.
4. Propose a fix that honors past root causes AND constraints. Apply it and run the tests.
5. If the fix encodes a non-trivial choice, \`hunch_record_decision(...)\` so the next session is grounded in it.
`;

const FRAGILE_CMD = `---
description: Report the most fragile parts of this codebase, with evidence
---
Ask Hunch for the fragility ranking (run \`hunch fragile\` or query Hunch),
then produce a **fragility report with evidence**: the specific files/functions,
the bug history behind them, their churn and fan-in, and any missing guards.
Avoid generic advice — every claim must cite a Hunch record or metric.
`;

export interface ClaudeHookInstall {
  path: string;
  action: "created" | "updated" | "unchanged";
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

/** A settings.json hook entry is Hunch's if any of its commands ends with the
 *  Hunch CLI entry + the `hook` subcommand (e.g. `…/index.js hook`). Matching the
 *  command TAIL — not the absolute path — makes re-init idempotent AND survives a
 *  repo-folder rename (the path before index.js changes; the tail does not). The
 *  leading path separator (`/` or `\`) requires `index` to be a full path segment,
 *  so a foreign tool's `…/myindex.js hook` isn't mistaken for ours and clobbered. */
function isHunchHook(entry: HookEntry): boolean {
  return !!entry.hooks?.some((h) => typeof h.command === "string" && /[\\/]index\.(js|ts)"?\s+hook\s*$/.test(h.command));
}

/**
 * Install the Claude Code AGENT hooks into `.claude/settings.json` so the agent
 * is grounded in Hunch automatically (not by remembering to call the tools):
 *   - PreToolUse (Edit|Write|MultiEdit) → inject the relevant Hunch slice before
 *     an edit, and (at strict firmness) deny edits that hit a blocking invariant.
 *   - UserPromptSubmit → remind the agent to consult Hunch.
 * Both invoke `hunch hook`, which reads the firmness level from .hunch/config.json
 * at run time — so changing firmness needs no settings.json edit. We own only our
 * entries (matched by isHunchHook): other hooks and settings are preserved, and a
 * non-empty file we cannot parse THROWS rather than clobbering the user's config.
 */
export function installClaudeHooks(root: string, hookCmd: string): ClaudeHookInstall {
  const file = join(root, ".claude", "settings.json");
  const existed = existsSync(file);
  let json: { hooks?: Record<string, HookEntry[]>; [k: string]: unknown } = {};
  let before = "";
  if (existed) {
    before = readFileSync(file, "utf8");
    if (before.trim()) {
      try {
        const v = JSON.parse(before);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
        json = v;
      } catch (e) {
        throw new Error(`refusing to overwrite ${file}: could not parse it (${(e as Error).message}). Fix or remove it, then re-run.`);
      }
    }
  }
  json.hooks = json.hooks ?? {};
  const keep = (arr?: HookEntry[]) => (Array.isArray(arr) ? arr.filter((e) => !isHunchHook(e)) : []);

  json.hooks.PreToolUse = [
    ...keep(json.hooks.PreToolUse),
    { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: hookCmd }] },
  ];
  json.hooks.UserPromptSubmit = [
    ...keep(json.hooks.UserPromptSubmit),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];

  const next = JSON.stringify(json, null, 2) + "\n";
  if (existed && before === next) return { path: file, action: "unchanged" };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return { path: file, action: existed ? "updated" : "created" };
}

export function writeSlashCommands(root: string): string[] {
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const files: Array<[string, string]> = [
    ["hunch-why.md", WHY_CMD],
    ["hunch-fix.md", FIX_CMD],
    ["hunch-fragile.md", FRAGILE_CMD],
  ];
  for (const [name, body] of files) {
    const p = join(dir, name);
    writeFileSync(p, body);
    written.push(p);
  }
  return written;
}
