/**
 * Workspace ledger wiring (docs/workspace-ledger.md, Phase 2): the ONE code path every
 * surface uses to read the ledger (CLI `workspaces` / `branches`, the `hunch_workspaces`
 * MCP tool, `hunch now`, `doctor`) and to record this machine's snapshot (CLI `snapshot`,
 * `hunch worktree`, the git hooks, MCP session start).
 *
 * This machine is always read LIVE from git and never from a stored record; stored
 * records (other machines) are display-only. A snapshot writes through the same capture
 * funnel as every other record: the overlay when one is configured, the public .hunch/
 * only when `workspaces.publish_public` opts in, nothing otherwise.
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { foreignRepoEnv, mainWorktreeRoot } from "../extractors/git.js";
import { hunchPaths } from "../core/paths.js";
import { readConfig, workspacesConfig, type WorkspacesConfig } from "../core/config.js";
import { loadOrCreateMachine, type MachineIdentity } from "../core/machine.js";
import {
  ago, branchRows, isSafeBranchName, latestPerMachine, isUnverified, planPrune, sameWorkspaceContent, worktreeRows,
  type BranchRow, type PrunePlan, type PruneStep, type Workspace, type WorktreeRow,
} from "../core/workspace.js";
import { snapshotWorkspace } from "../extractors/workspaces.js";
import type { HunchStore } from "../store/hunchStore.js";
import { flushCapture } from "./sync.js";

export interface LedgerView {
  machine: MachineIdentity;
  /** This machine, live (paths included; never written). */
  live: Workspace;
  /** live + every OTHER machine's stored record. */
  records: Workspace[];
  config: WorkspacesConfig;
}

export function workspaceLedgerView(store: HunchStore, root: string, opts: { fetch?: boolean } = {}): LedgerView {
  const machine = loadOrCreateMachine();
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  const live = snapshotWorkspace(root, { machine, publish: "full", fetch: !!opts.fetch });
  const others = store.recs("workspaces").filter((r) => r.machine.id !== machine.id);
  return { machine, live, records: [live, ...others], config };
}

export type SnapshotOutcome =
  | { status: "off" }
  | { status: "dry-run"; record: Workspace }
  | { status: "no-home"; record: Workspace }
  | { status: "unchanged"; record: Workspace; previous: Workspace }
  /** The OTHER memory home already holds a record with this machine's id (an old public
   *  copy, or a record someone else wrote under this id): the store refuses a twin, and so
   *  do we — `hunch workspaces forget <id>` removes the stale copy. */
  | { status: "collision"; record: Workspace; reason: string }
  | { status: "written"; record: Workspace; home: "private" | "public"; flushed: "pushed" | "committed" | null };

/** Record this machine's snapshot. Honors `workspaces.publish`, skips a write when the
 *  content is unchanged and the stored record is under a day old (an idle machine's hooks
 *  must not commit a record per checkout), and reports exactly what happened. */
export function recordWorkspaceSnapshot(store: HunchStore, root: string, opts: { fetch?: boolean; dryRun?: boolean } = {}): SnapshotOutcome {
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  if (config.publish === "off") return { status: "off" };
  const machine = loadOrCreateMachine();
  const record = snapshotWorkspace(root, { machine, publish: config.publish, fetch: !!opts.fetch });
  if (opts.dryRun) return { status: "dry-run", record };
  const isPrivate = store.hasPrivate;
  if (!isPrivate && !config.publish_public) return { status: "no-home", record };
  const previous = store.getRec("workspaces", record.id);
  if (previous && Date.now() - Date.parse(previous.observed_at) < 86_400_000 && sameWorkspaceContent(previous, record)) {
    return { status: "unchanged", record, previous };
  }
  try {
    store.putCapture("workspaces", record, isPrivate);
  } catch (error) {
    const reason = (error as Error).message;
    if (/already exists in the other memory home/.test(reason)) return { status: "collision", record, reason };
    throw error;
  }
  const flushed = flushCapture(store, hunchPaths(root).hunch, isPrivate, `hunch: workspace snapshot ${machine.label}`);
  return { status: "written", record, home: isPrivate ? "private" : "public", flushed };
}

/** Whether a snapshot could land anywhere on this root — used to skip spawning a
 *  background snapshot that would write nothing. */
export function snapshotHasHome(store: HunchStore, root: string): boolean {
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  return config.publish !== "off" && (store.hasPrivate || config.publish_public);
}

/** Fire-and-forget `hunch workspaces snapshot --quiet` with this installation's launcher
 *  (never a global binary), detached so a long-lived host such as the MCP server never
 *  blocks on git. HUNCH_SYNC=1 keeps any memory commit it makes from re-triggering hooks. */
export function spawnWorkspaceSnapshot(root: string, launcherArgv: readonly string[]): boolean {
  const [file, ...rest] = launcherArgv;
  if (!file) return false;
  try {
    const child = spawn(file, [...rest, "workspaces", "snapshot", "--quiet"], {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, HUNCH_SYNC: "1" },
    });
    child.once("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---- rendering (shared by the CLI and the MCP tool) -----------------------------------------

export function padTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c ?? "" : (c ?? "").padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export function renderWorktreeTable(view: LedgerView, rows: WorktreeRow[], now = new Date()): string {
  const table = padTable(["MACHINE", "WORKTREE", "BRANCH", "DIRTY", "LAST COMMIT", "SEEN"], rows.map((r) => [
    r.machine + (r.machine === view.machine.label ? " (this)" : ""),
    r.path ?? "yes",
    r.branch ?? `(detached ${r.head.slice(0, 10)})`,
    r.dirty === null ? "?" : r.dirty ? "yes" : "-",
    r.last_commit_at ? ago(r.last_commit_at, now) : "-",
    (r.machine === view.machine.label ? "live" : ago(r.seen_at, now)) + (r.unverified ? " (unverified)" : "") + (r.prunable ? " (path missing)" : "") + (r.locked ? " (locked)" : ""),
  ]));
  return `${table}\n\n${rows.length} worktree(s) · this machine is ${view.machine.label} · ${view.records.length - 1} other machine(s) in memory`;
}

export function describeUpstream(r: BranchRow): string {
  if (r.upstream === null) return "never pushed";
  if (r.upstream_gone) return "gone";
  return [r.ahead ? `ahead ${r.ahead}` : "", r.behind ? `behind ${r.behind}` : ""].filter(Boolean).join(", ") || "synced";
}

export function renderBranchTable(view: LedgerView, rows: BranchRow[]): string {
  const table = padTable(["BRANCH", "MACHINES", "WORKTREE", "UPSTREAM", "MERGED", "ACTION"], rows.map((r) => [
    r.name,
    r.machines.join(","),
    r.worktree_on.length ? r.worktree_on.join(",") + (r.dirty_on.length ? " (dirty)" : "") : "-",
    describeUpstream(r),
    r.merged.status === "merged" ? `yes (${r.merged.method}${r.merged.pr ? `, PR #${r.merged.pr}` : ""})` : r.merged.status === "unmerged" ? "no" : "unknown",
    r.action,
  ]));
  const deletable = rows.filter((r) => r.action.startsWith("delete local")).length;
  const warn = view.live.default_branch === null ? "\n  ⚠ no default branch resolved (origin/HEAD, origin/main|master, main|master) — merge verdicts are unknown" : "";
  return `${table}\n\n${rows.length} branch(es) · ${deletable} deletable · this machine is ${view.machine.label}${warn}`;
}

/** One line for `hunch now` / `hunch_now`, from STORED records only (no git, so the hot
 *  view stays fast); null when memory holds no workspace record. */
export function workspaceSummaryLine(records: readonly Workspace[], config: WorkspacesConfig, now = new Date()): string | null {
  const latest = latestPerMachine(records);
  if (!latest.length) return null;
  const opts = { staleAfterDays: config.stale_after_days, now };
  const worktrees = worktreeRows(latest, opts);
  const branches = branchRows(latest, opts);
  const unverified = latest.filter((r) => isUnverified(r, opts)).length;
  const deletable = branches.filter((b) => b.action.startsWith("delete local")).length;
  const dirty = worktrees.filter((w) => w.dirty === true).length;
  return `🗂 Workspaces in memory: ${latest.length} machine(s)${unverified ? ` (${unverified} unverified)` : ""} · ${worktrees.length} worktree(s)${dirty ? ` (${dirty} dirty)` : ""} · ${branches.length} branch(es), ${deletable} deletable — \`hunch branches\` for the verdicts`;
}

export { branchRows, worktreeRows };

// ---- prune (Phase 3) ------------------------------------------------------------------------
//
// `--apply` acts on THIS machine only, from a snapshot taken moments ago (never a stored
// record), with `git worktree remove` (no --force) and `git branch -d` (no -D), so git itself
// re-checks "clean" and "merged" as a second line of defense. Nothing here touches a remote
// or another machine; their commands are printed for a human to run there.

export function prunePlanFor(view: LedgerView): PrunePlan {
  return planPrune(view.live, view.records);
}

export interface PruneResult {
  step: PruneStep;
  outcome: "deleted" | "failed";
  detail: string;
}

/** Execute the local steps of a plan. Each command is a fixed argv; the branch name was
 *  validated by the record schema and is passed after `--`; the worktree path comes from
 *  `git worktree list` on this machine. A failure stops that step, never the others. */
export function applyPrune(root: string, steps: readonly PruneStep[]): PruneResult[] {
  const main = mainWorktreeRoot(root);
  const env = foreignRepoEnv(process.env);
  const git = (args: string[]): string => execFileSync("git", args, { cwd: main, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const results: PruneResult[] = [];
  for (const step of steps) {
    if (!isSafeBranchName(step.branch)) { results.push({ step, outcome: "failed", detail: "refused: unsafe branch name" }); continue; }
    try {
      const detail: string[] = [];
      if (step.worktree?.path) { git(["worktree", "remove", "--", step.worktree.path]); detail.push(`removed worktree ${step.worktree.path}`); }
      else if (step.worktree) { results.push({ step, outcome: "failed", detail: "refused: the worktree's path is not known on this machine" }); continue; }
      git(["branch", "-d", "--", step.branch]);
      detail.push(`deleted branch ${step.branch} (was ${step.head.slice(0, 12)})`);
      results.push({ step, outcome: "deleted", detail: detail.join("; ") });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.toString().trim().split("\n")[0] ?? (error as Error).message;
      results.push({ step, outcome: "failed", detail: `git refused: ${stderr}` });
    }
  }
  return results;
}

/** Interactive yes/no; false when stdin is not a terminal (the caller then needs --yes). */
export async function confirmPrune(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally { rl.close(); }
}

export function renderPrunePlan(view: LedgerView, plan: PrunePlan): string {
  const L: string[] = [];
  L.push(`This machine (${view.machine.label}) — ${plan.local.length} branch(es) provably merged and safe to delete:`);
  if (!plan.local.length) L.push("  (nothing)");
  for (const step of plan.local) {
    L.push(`  ${step.branch}  — ${step.why}`);
    for (const c of step.commands) L.push(`    ${c}`);
  }
  if (plan.skipped.length) {
    L.push("", "Merged but left alone on this machine:");
    for (const s of plan.skipped) L.push(`  ${s.branch}  — ${s.reason}`);
  }
  for (const [label, steps] of Object.entries(plan.others)) {
    const record = view.records.find((r) => r.machine.label === label);
    const stale = record && isUnverified(record, { staleAfterDays: view.config.stale_after_days }) ? " (unverified — the record is old)" : "";
    L.push("", `On ${label}${stale} — run there, from that machine's stored record (never executed from here):`);
    for (const step of steps) for (const c of step.commands) L.push(`  ${c}`);
  }
  return L.join("\n");
}
