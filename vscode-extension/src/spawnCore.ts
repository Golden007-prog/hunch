/**
 * The vscode-free core of the extension's CLI seam — extracted so the G3
 * adapter-conformance fixture can execute the EXACT code path the panel uses
 * (arg quoting, the Windows npm-shim spawn strategy, result shaping) from a plain
 * node:test, without a VS Code host. Certification doctrine: labels are not
 * evidence — only running this real seam is (dec_ce86ca9cec).
 *
 * cli.ts wraps this with the vscode-only concerns (config lookup, PATH probing,
 * progress UI). Behavior here must stay byte-compatible with what the panel runs.
 */
import * as cp from "node:child_process";
import { normalize } from "node:path";

export interface CliResult { ok: boolean; stdout: string; stderr: string; code: number | null; }

// Escaping adapted from cross-spawn 7.0.6 (MIT).
// Copyright (c) 2018 Made With MOXY Lda; see THIRD_PARTY_NOTICES.md.
const CMD_META = /([()\][%!^"\x60<>&|;, *?])/g;

function escapeWinCommand(value: string): string {
  // The command is parsed once by cmd.exe. Arguments passed to a .cmd shim
  // are parsed again by the shim, which is why winQuote() double-escapes its
  // metacharacters. The command itself needs only the first pass.
  return String(value).replace(CMD_META, "^$1");
}

function escapeWinArgument(value: string): string {
  let arg = String(value);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  arg = arg.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  // Escape twice: the npm cmd shim invokes Node through a second cmd parser.
  return ('"' + arg + '"').replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** Quote one arg for cmd.exe. The argument is always protected with the
 *  cross-spawn caret algorithm because double quotes do not stop percent
 *  expansion. The npm cmd shim needs the meta characters escaped twice. */
export function winQuote(a: string): string {
  return escapeWinArgument(a);
}

/** One launcher for buffered, streaming and MCP clients. Native executable
 * argv bypasses the shell; npm shims use the same protected command line. */
function invocation(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== "win32" || /\.(?:exe|com)$/i.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const shellCommand = [escapeWinCommand(normalize(command)), ...args.map(winQuote)].join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/v:off", "/c", `"${shellCommand}"`], windowsVerbatimArguments: true };
}

export function spawnHunchWith(command: string, root: string, args: string[]): cp.ChildProcessWithoutNullStreams {
  const launch = invocation(command, args);
  return cp.spawn(launch.command, launch.args, { cwd: root, windowsVerbatimArguments: launch.windowsVerbatimArguments });
}

/** Run `<command> <args...>` in `root`. Resolves (never rejects) so callers branch
 *  on `.ok`.
 *
 *  Windows: npm installs `hunch` as a `.cmd`/`.ps1` shim, NOT a native exe. Node ≥18.20
 *  refuses to spawn such a shim via execFile WITHOUT a shell (CVE-2024-27980 hardening) —
 *  it fails ENOENT with empty stdout. So on Windows we run through cmd.exe with each arg
 *  quoted ourselves (shell:true would concatenate them unescaped — DEP0190). Elsewhere
 *  the argv form is safe and shell-free. */
export function runHunchWith(command: string, root: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  const opts = { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };
  const settle = (resolve: (r: CliResult) => void) => (err: cp.ExecException | cp.ExecFileException | null, stdout: string, stderr: string) => {
    const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
    resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", code });
  };
  return new Promise((resolve) => {
    const launch = invocation(command, args);
    cp.execFile(launch.command, launch.args, { ...opts, windowsVerbatimArguments: launch.windowsVerbatimArguments }, settle(resolve));
  });
}
