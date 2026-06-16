/**
 * Multi-assistant compatibility (DESIGN §7, extended). The Hunch MCP server is
 * client-agnostic — any MCP-capable assistant can call the `hunch_*` tools. The
 * only per-tool difference is HOW each one is told to launch the server and where
 * its ambient grounding lives. This module scaffolds those surfaces for the major
 * assistants so the same `.hunch/` graph powers all of them:
 *
 *   Assistant   | MCP config              | root key       | grounding file
 *   ------------|-------------------------|----------------|---------------------------------
 *   Claude Code | .mcp.json               | mcpServers     | CLAUDE.md            (scaffold.ts)
 *   Cursor      | .cursor/mcp.json        | mcpServers     | .cursor/rules/hunch.mdc
 *   VS Code     | .vscode/mcp.json        | servers (+type)| .github/copilot-instructions.md
 *   Codex CLI   | .codex/config.toml      | [mcp_servers.*]| AGENTS.md
 *   (any other) | —                       | —              | AGENTS.md (cross-tool standard)
 *
 * Every writer MERGES into existing files (preserving other servers / user prose)
 * and is idempotent, so re-running `hunch init` is safe.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { Invocation } from "./scaffold.js";
import { renderHunchSection, upsertSection } from "./claudemd.js";

function readJsonObj(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeJson(file: string, obj: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return file;
}

/** Cursor: .cursor/mcp.json — same `mcpServers` shape as Claude Desktop/Code. */
export function writeCursorMcp(root: string, inv: Invocation): string {
  const file = join(root, ".cursor", "mcp.json");
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

/** VS Code (Copilot agent mode): .vscode/mcp.json — root key is `servers`, and
 *  each stdio entry carries an explicit `type: "stdio"` (VS Code's schema). */
export function writeVscodeMcp(root: string, inv: Invocation): string {
  const file = join(root, ".vscode", "mcp.json");
  const json = readJsonObj(file) as { servers?: Record<string, unknown> };
  json.servers = json.servers ?? {};
  json.servers.hunch = { type: "stdio", command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

const TOML_START = "# >>> hunch mcp (managed) >>>";
const TOML_END = "# <<< hunch mcp <<<";

/** Codex CLI: .codex/config.toml — `[mcp_servers.hunch]` stdio entry. We own only
 *  a marker-delimited block; any other TOML the user has is preserved. Paths use
 *  TOML single-quote LITERAL strings so Windows backslashes need no escaping. */
export function writeCodexConfig(root: string, inv: Invocation): string {
  const file = join(root, ".codex", "config.toml");
  const argsToml = [...inv.args, "mcp"].map((a) => `'${a}'`).join(", ");
  const block = [
    TOML_START,
    "[mcp_servers.hunch]",
    `command = '${inv.command}'`,
    `args = [${argsToml}]`,
    TOML_END,
  ].join("\n");
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const i = content.indexOf(TOML_START);
  const j = content.indexOf(TOML_END);
  if (i >= 0 && j > i) {
    content = content.slice(0, i) + block + content.slice(j + TOML_END.length);
  } else if (i >= 0 || j >= 0) {
    const body = content.split("\n").filter((l) => !l.includes(TOML_START) && !l.includes(TOML_END)).join("\n").trimEnd();
    content = body ? `${body}\n\n${block}\n` : `${block}\n`;
  } else {
    content = content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** AGENTS.md — the cross-tool ambient-instruction standard (Codex and a growing
 *  set of assistants read it). Marker-delimited so user prose is preserved. */
export function writeAgentsMd(root: string, store: HunchStore): string {
  return upsertSection(join(root, "AGENTS.md"), renderHunchSection(store), "# AGENTS.md");
}

/** GitHub Copilot custom instructions (VS Code / github.com). Same grounding. */
export function writeCopilotInstructions(root: string, store: HunchStore): string {
  return upsertSection(join(root, ".github", "copilot-instructions.md"), renderHunchSection(store), "# Copilot instructions");
}

/** Cursor project rule (.mdc = frontmatter + body). `alwaysApply` keeps the Hunch
 *  grounding in context for every request. Fully managed by Hunch (overwritten). */
export function writeCursorRule(root: string, store: HunchStore): string {
  const file = join(root, ".cursor", "rules", "hunch.mdc");
  const body = `---\ndescription: Hunch engineering memory — consult the hunch_* MCP tools before editing\nalwaysApply: true\n---\n\n${renderHunchSection(store)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

export interface ProviderScaffold {
  assistant: string;
  files: string[];
}

/** Scaffold MCP config + grounding for all supported assistants. Returns a
 *  per-assistant summary for `hunch init` to print. Claude Code is handled
 *  separately by scaffold.ts (.mcp.json + slash commands + CLAUDE.md). */
export function scaffoldProviders(root: string, inv: Invocation, store: HunchStore): ProviderScaffold[] {
  return [
    { assistant: "Cursor", files: [writeCursorMcp(root, inv), writeCursorRule(root, store)] },
    { assistant: "VS Code (Copilot)", files: [writeVscodeMcp(root, inv), writeCopilotInstructions(root, store)] },
    { assistant: "Codex CLI", files: [writeCodexConfig(root, inv)] },
    { assistant: "Any (AGENTS.md)", files: [writeAgentsMd(root, store)] },
  ];
}
