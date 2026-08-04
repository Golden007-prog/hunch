/**
 * Resolve MCP client roots to the one repository this server may safely serve.
 *
 * A server process keeps the cwd it was spawned with, while the client can move to
 * another workspace or linked worktree. MCP roots are the client-neutral protocol
 * mechanism for following that change.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, HUNCH_DIR, isDir } from "../core/paths.js";

/** One canonical spelling per directory. `findRoot` only resolve()s, but a
 *  client's roots/list URI can spell the same repo differently — VS Code sends
 *  a lowercase drive letter (`c:\…`) while the spawn cwd has `C:\…`, and Git
 *  for Windows can surface 8.3/short names. Raw string comparison then treats
 *  ONE repo as different roots: a full re-prepare (new store + reindex) on
 *  every connect, or a false "multiple roots equally plausible" refusal
 *  (issue #54). realpathSync.native returns the on-disk spelling for all of
 *  these; fall back to the input when the path is transiently unreadable. */
export function canonicalRootPath(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

function toPath(uri: string): string {
  if (!uri.startsWith("file:")) return "";
  try {
    return fileURLToPath(uri);
  } catch {
    return "";
  }
}

function rootStart(path: string): string {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return path;
    if (stat.isFile()) return dirname(path);
  } catch {
    // Missing/inaccessible roots are unusable.
  }
  return "";
}

/**
 * Returns null when several advertised repositories are equally plausible.
 * The roots protocol exposes a set of URI/name pairs, not an "active root" bit;
 * choosing the first Hunch store in that case could silently write repo B's
 * decision into repo A.
 */
export function resolveActiveRoot(rootUris: readonly string[], fallbackCwd: string): string | null {
  const candidates: string[] = [];
  for (const uri of rootUris) {
    const start = rootStart(toPath(uri));
    if (!start) continue;
    const root = canonicalRootPath(findRoot(start));
    if (!candidates.includes(root)) candidates.push(root);
  }

  if (!candidates.length) return canonicalRootPath(findRoot(fallbackCwd));
  if (candidates.length === 1) return candidates[0]!;

  const withStore = candidates.filter((candidate) => isDir(join(candidate, HUNCH_DIR)));
  return withStore.length === 1 ? withStore[0]! : null;
}
