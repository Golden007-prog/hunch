/** Files the repository shows as worked on while a task was open.
 *
 * The pre-edit hook only sees edits made through an instrumented editor tool.
 * Work done from a shell (patch scripts, rebases, release commits) never
 * produced a delivery, so the task record had no file anchor for it and the
 * ranking could not relate the task to later work on the same files. Two
 * sources fill that gap, both bounded and fail-open (an error yields nothing,
 * never a failed finish):
 *  - commits authored by the configured git user whose commit time falls in
 *    the task window (merges excluded);
 *  - working-tree changes (modified, added, untracked) whose mtime falls in it.
 * Hunch's own memory and cache paths are excluded, so a capture commit made
 * during the task does not count as work on a file. Deleted paths are skipped:
 * nothing dates the deletion. Commit dates get one second of slack (git keeps
 * seconds); working-tree mtimes get none before the start. */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED_SEGMENTS = new Set([".hunch", ".hunch-cache", ".git"]);

function gitDate(ms: number): string {
  // Second resolution, a format every git accepts.
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} +0000`;
}

export function gitTouchedFiles(root: string, startedAt: string, finishedAt: string | null, options: { limit?: number; timeoutMs?: number; now?: number } = {}): string[] {
  const limit = Math.max(1, options.limit ?? 64);
  const timeout = options.timeoutMs ?? 3_000;
  const since = Date.parse(startedAt);
  if (!Number.isFinite(since)) return [];
  const until = finishedAt ? Date.parse(finishedAt) : (options.now ?? Date.now());
  if (!Number.isFinite(until) || until < since) return [];
  // One second of slack on each side: git dates and some filesystems are second-granular.
  const from = since - 1_000, to = until + 1_000;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete env[key];
  const run = (args: string[]): string => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { env, encoding: "utf8", timeout, maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] });
  const out = new Set<string>();
  const keep = (raw: string): void => {
    const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) return;
    out.add(path);
  };
  try {
    const email = run(["config", "--get", "user.email"]).trim();
    if (email) {
      const log = run(["log", "--no-merges", "-n", "50", `--since=${gitDate(from)}`, `--until=${gitDate(to)}`, `--author=${email}`, "--format=", "--name-only"]);
      for (const line of log.split("\n")) keep(line);
    }
  } catch { /* no commits, no git user, or no git: the working tree may still say something */ }
  try {
    const entries = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2), path = entry.slice(3);
      // A rename or copy is followed by its original path as a separate entry.
      if (code[0] === "R" || code[0] === "C") i++;
      if (code.includes("D") || !path) continue;
      try {
        const mtime = statSync(join(root, path)).mtimeMs;
        if (mtime >= since && mtime <= to) keep(path);
      } catch { /* vanished between status and stat */ }
    }
  } catch { /* not a git worktree or status failed: nothing to add */ }
  return [...out].sort().slice(0, limit);
}
