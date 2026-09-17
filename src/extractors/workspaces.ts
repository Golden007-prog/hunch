/**
 * Workspace snapshot — THIS machine's worktrees and local branches, read from git with a
 * fixed set of commands (docs/workspace-ledger.md). Deterministic, no LLM, no network
 * unless `fetch` is explicitly requested.
 *
 * Every git invocation here uses execFileSync with a literal argv (never a shell), passes
 * refs after `--end-of-options` / `--`, runs under `foreignRepoEnv` (so a hook's GIT_DIR
 * cannot redirect a per-worktree query), and has a timeout. Paths come from
 * `git worktree list` on this machine only — never from a stored record.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { foreignRepoEnv, gitCommonDir, mainWorktreeRoot, stableRepositoryName } from "./git.js";
import { extracted } from "../core/types.js";
import {
  WORKSPACE_SCHEMA_VERSION, WorkspaceSchema, isSafeBranchName, workspaceId, worktreeId,
  type MergedVerdict, type Workspace, type WorkspaceBranch, type WorkspaceWorktree,
} from "../core/workspace.js";
import type { MachineIdentity } from "../core/machine.js";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_OUTPUT = 64 * 1024 * 1024;
/** How far back in the default branch a squash-merge is searched for. */
export const DEFAULT_SQUASH_SEARCH_COMMITS = 2000;

export interface SnapshotOptions {
  machine: MachineIdentity;
  publish: "full" | "branches";
  /** Run `git fetch --prune` first. Off by default: hooks must stay offline-safe. */
  fetch?: boolean;
  now?: Date;
  squashSearchCommits?: number;
}

function env(): NodeJS.ProcessEnv {
  return foreignRepoEnv(process.env);
}

function run(cwd: string, args: string[], timeout = 10_000): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT, env: env(), timeout, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Exit status of a git predicate: 0 → true, 1 → false, anything else (git missing,
 *  timeout, fatal) → null. Never collapse "no" and "error" (the CommitRepairStatus rule). */
function predicate(cwd: string, args: string[]): boolean | null {
  const r = spawnSync("git", args, { cwd, env: env(), timeout: 10_000, stdio: "ignore" });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return true;
  return r.status === 1 ? false : null;
}

function sha(value: string | null): string | null {
  const v = value?.trim() ?? "";
  return SHA.test(v) ? v : null;
}

function iso(value: string | null): string | null {
  const v = value?.trim() ?? "";
  if (!v || !Number.isFinite(Date.parse(v))) return null;
  return new Date(v).toISOString();
}

interface DefaultBranch { name: string; ref: string; head: string }

/** origin/HEAD → origin/main|master → local main|master. Null when none resolves: every
 *  verdict is then `unknown`, never `unmerged`. */
function defaultBranch(root: string): DefaultBranch | null {
  const candidates: Array<{ name: string; ref: string; full: string }> = [];
  const symbolic = run(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])?.trim();
  if (symbolic?.startsWith("refs/remotes/origin/")) {
    const name = symbolic.slice("refs/remotes/origin/".length);
    candidates.push({ name, ref: `origin/${name}`, full: symbolic });
  }
  for (const name of ["main", "master"]) {
    candidates.push({ name, ref: `origin/${name}`, full: `refs/remotes/origin/${name}` });
  }
  for (const name of ["main", "master"]) candidates.push({ name, ref: name, full: `refs/heads/${name}` });
  for (const c of candidates) {
    if (!isSafeBranchName(c.name)) continue;
    const head = sha(run(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${c.full}^{commit}`]));
    if (head) return { name: c.name, ref: c.ref, head };
  }
  return null;
}

interface RawWorktree { path: string; head: string; branch: string | null; locked: boolean; prunable: boolean; bare: boolean }

function listWorktrees(root: string): RawWorktree[] {
  const out = run(root, ["worktree", "list", "--porcelain"]) ?? "";
  const items: RawWorktree[] = [];
  let cur: Partial<RawWorktree> | null = null;
  const flush = () => {
    if (cur?.path && cur.head) items.push({ path: cur.path, head: cur.head, branch: cur.branch ?? null, locked: !!cur.locked, prunable: !!cur.prunable, bare: !!cur.bare });
    cur = null;
  };
  for (const line of out.split("\n")) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith("worktree ")) { flush(); cur = { path: line.slice(9) }; continue; }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = sha(line.slice(5)) ?? undefined;
    else if (line.startsWith("branch refs/heads/")) { const b = line.slice("branch refs/heads/".length); cur.branch = isSafeBranchName(b) ? b : null; }
    else if (line === "detached") cur.branch = null;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
    else if (line === "bare") cur.bare = true;
  }
  flush();
  return items.filter((w) => !w.bare);
}

/** `git status --porcelain` is non-empty → uncommitted or untracked work that
 *  `git worktree remove` would refuse to discard. null when the path is gone. */
function isDirty(path: string): boolean | null {
  if (!existsSync(path)) return null;
  const out = run(path, ["status", "--porcelain", "--ignore-submodules"]);
  return out === null ? null : out.trim().length > 0;
}

interface RawBranch { name: string; head: string; upstream: string | null; track: string; date: string | null; worktreePath: string | null }

function listBranches(root: string): RawBranch[] {
  const format = ["%(refname)", "%(objectname)", "%(upstream)", "%(upstream:track,nobracket)", "%(committerdate:iso-strict)", "%(worktreepath)"].join("%00");
  const out = run(root, ["for-each-ref", `--format=${format}`, "refs/heads/"]) ?? "";
  const items: RawBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [refname = "", objectname = "", upstream = "", track = "", date = "", worktreePath = ""] = line.split("\0");
    if (!refname.startsWith("refs/heads/")) continue;
    const name = refname.slice("refs/heads/".length);
    const head = sha(objectname);
    if (!head || !isSafeBranchName(name)) continue;
    const up = upstream.startsWith("refs/remotes/") ? upstream.slice("refs/remotes/".length) : null;
    items.push({ name, head, upstream: up, track, date: iso(date), worktreePath: worktreePath || null });
  }
  return items;
}

function parseTrack(track: string): { gone: boolean; ahead: number | null; behind: number | null } {
  if (track.trim() === "gone") return { gone: true, ahead: null, behind: null };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { gone: false, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** patch-id of the whole diff between two commits: what a squash-merge lands as one commit. */
function combinedPatchId(root: string, base: string, head: string): string | null {
  let diff: Buffer;
  try {
    diff = execFileSync("git", ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head, "--"],
      { cwd: root, env: env(), maxBuffer: MAX_OUTPUT, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  if (!diff.byteLength) return null;
  const r = spawnSync("git", ["patch-id", "--stable"], { cwd: root, env: env(), input: diff, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  const id = r.stdout.trim().split(/\s+/)[0] ?? "";
  return SHA.test(id) ? id : null;
}

/** patch-id → commit for the last N non-merge commits of the default branch, computed
 *  ONCE per snapshot (one `git log -p | git patch-id` pipeline). */
function defaultBranchPatchIds(root: string, ref: string, limit: number): Map<string, string> {
  const map = new Map<string, string>();
  let log: Buffer;
  try {
    log = execFileSync("git", ["log", "--format=%H", "-p", "--no-merges", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", `-n${limit}`, ref, "--"],
      { cwd: root, env: env(), maxBuffer: MAX_OUTPUT, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return map; }
  if (!log.byteLength) return map;
  const r = spawnSync("git", ["patch-id", "--stable"], { cwd: root, env: env(), input: log, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 60_000 });
  if (r.error || r.status !== 0) return map;
  for (const line of r.stdout.split("\n")) {
    const [patchId = "", commit = ""] = line.trim().split(/\s+/);
    if (SHA.test(patchId) && SHA.test(commit) && !map.has(patchId)) map.set(patchId, commit);
  }
  return map;
}

function mergedVerdict(root: string, head: string, def: DefaultBranch | null, patchIds: () => Map<string, string>, searched: number): MergedVerdict {
  if (!def) return { status: "unknown", method: null, evidence: ["no default branch resolved (origin/HEAD, origin/main, origin/master, main, master)"] };
  const ancestor = predicate(root, ["merge-base", "--is-ancestor", head, def.head]);
  if (ancestor === null) return { status: "unknown", method: null, evidence: ["git merge-base failed"] };
  if (ancestor) return { status: "merged", method: "ancestry", evidence: [`${head.slice(0, 12)} is an ancestor of ${def.ref}@${def.head.slice(0, 12)}`] };
  const base = sha(run(root, ["merge-base", head, def.head]));
  if (!base) return { status: "unknown", method: null, evidence: [`no merge base with ${def.ref}`] };
  const combined = combinedPatchId(root, base, head);
  if (combined) {
    const commit = patchIds().get(combined);
    if (commit) return { status: "merged", method: "squash", evidence: [`patch-id of ${base.slice(0, 12)}..${head.slice(0, 12)} equals ${def.ref} commit ${commit.slice(0, 12)}`] };
  }
  const cherry = run(root, ["cherry", def.head, head]);
  if (cherry !== null) {
    const lines = cherry.split("\n").filter(Boolean);
    if (lines.length && lines.every((l) => l.startsWith("-"))) {
      return { status: "merged", method: "rebase", evidence: [`all ${lines.length} commit(s) have an equivalent patch in ${def.ref} (git cherry)`] };
    }
  }
  return { status: "unmerged", method: null, evidence: [`not in ${def.ref}@${def.head.slice(0, 12)}; squash searched last ${searched} commits`] };
}

function fetchedAt(root: string): string | null {
  const common = gitCommonDir(root);
  if (!common) return null;
  try { return statSync(join(common, "FETCH_HEAD")).mtime.toISOString(); } catch { return null; }
}

/** Snapshot this machine's workspace for the repository at `root`. Validated against the
 *  strict schema before it is returned, so the extractor can never emit a record the
 *  loader would refuse. */
export function snapshotWorkspace(root: string, opts: SnapshotOptions): Workspace {
  const now = opts.now ?? new Date();
  const main = mainWorktreeRoot(root);
  if (opts.fetch) run(main, ["fetch", "--prune", "--quiet"], 120_000);
  const def = defaultBranch(main);
  const searched = opts.squashSearchCommits ?? DEFAULT_SQUASH_SEARCH_COMMITS;
  let patchIds: Map<string, string> | null = null;
  const lazyPatchIds = () => (patchIds ??= def ? defaultBranchPatchIds(main, def.head, searched) : new Map());

  const rawWorktrees = listWorktrees(main);
  const worktrees: WorkspaceWorktree[] = rawWorktrees.map((w) => ({
    id: worktreeId(w.path),
    path: opts.publish === "full" ? w.path : null,
    branch: w.branch,
    head: w.head,
    is_main: w.path === main,
    dirty: w.prunable ? null : isDirty(w.path),
    locked: w.locked,
    prunable: w.prunable,
    last_commit_at: iso(run(main, ["log", "-1", "--format=%cI", "--end-of-options", w.head, "--"])),
  }));
  const worktreeByPath = new Map(rawWorktrees.map((w) => [w.path, worktreeId(w.path)]));

  const branches: WorkspaceBranch[] = listBranches(main).map((b) => {
    const track = b.upstream ? parseTrack(b.track) : { gone: false, ahead: null, behind: null };
    return {
      name: b.name,
      head: b.head,
      is_default: def?.name === b.name,
      upstream: b.upstream,
      upstream_gone: track.gone,
      ahead: track.ahead,
      behind: track.behind,
      last_commit_at: b.date,
      worktree: (b.worktreePath && worktreeByPath.get(b.worktreePath)) || null,
      merged: def?.name === b.name
        ? { status: "unmerged", method: null, evidence: ["default branch"] }
        : mergedVerdict(main, b.head, def, lazyPatchIds, searched),
    };
  });

  const record: Workspace = {
    schema: WORKSPACE_SCHEMA_VERSION,
    id: workspaceId(opts.machine.id),
    machine: { id: opts.machine.id, label: opts.machine.label, platform: process.platform },
    repository: stableRepositoryName(main),
    publish: opts.publish,
    observed_at: now.toISOString(),
    fetched_at: fetchedAt(main),
    default_branch: def,
    worktrees,
    branches,
    provenance: extracted(1, [
      "git worktree list --porcelain", "git for-each-ref refs/heads/", "git status --porcelain",
      "git merge-base --is-ancestor", "git diff | git patch-id --stable", "git cherry",
    ]),
  };
  return WorkspaceSchema.parse(record);
}
