/** Resolve a user-supplied argv into something `spawn` can run without a shell.
 *
 * On POSIX the argv is already right. On Windows, `spawn("npx", ...)` with
 * `shell: false` fails: the launcher is `npx.cmd`, and Node refuses to run
 * `.cmd`/`.bat` files directly. The verification runner used to swallow that
 * as `exit_code: null`, so every contribution card on Windows said "no
 * independent command result". This keeps `shell: false` for real
 * executables and only routes batch launchers through `cmd.exe`, with the
 * npm/npx launchers run as plain Node scripts (no shell at all). */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResolvedSpawn {
  file: string;
  args: string[];
  /** Set when a batch launcher runs through cmd.exe and the line is pre-quoted. */
  windowsVerbatimArguments?: boolean;
  how: "direct" | "npm-cli" | "pathext" | "cmd-shim";
}

export interface SpawnResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (path: string) => boolean;
}

/** cmd.exe quoting for one argument: wrap when it has whitespace or shell
 * metacharacters; double embedded quotes. Good for test/build commands; a
 * deliberately hostile argument still cannot escape because the whole line is
 * passed as one `/s /c "..."` token. */
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function resolveSpawnCommand(command: readonly string[], options: SpawnResolveOptions = {}): ResolvedSpawn {
  const platform = options.platform ?? process.platform;
  const [cmd = "", ...args] = command;
  if (platform !== "win32") return { file: cmd, args, how: "direct" };
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const execPath = options.execPath ?? process.execPath;

  // npm / npx: run the CLI script with this same Node. No shim, no shell.
  if (/^(npm|npx)$/i.test(cmd)) {
    const script = join(dirname(execPath), "node_modules", "npm", "bin", `${cmd.toLowerCase()}-cli.js`);
    if (exists(script)) return { file: execPath, args: [script, ...args], how: "npm-cli" };
  }
  // A path or an explicit executable extension: spawn as given.
  if (/[\\/]/.test(cmd) || /\.(exe|com)$/i.test(cmd)) return { file: cmd, args, how: "direct" };

  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? "").split(";").map((d) => d.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ["", ...pathExt]) {
      const candidate = join(dir, cmd + ext);
      if (!exists(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const line = [candidate, ...args].map(quoteForCmd).join(" ");
        return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, how: "cmd-shim" };
      }
      if (ext === "" && !/\.(exe|com)$/i.test(candidate)) continue; // an extensionless file is not runnable on Windows
      return { file: candidate, args, how: "pathext" };
    }
  }
  return { file: cmd, args, how: "direct" };
}
