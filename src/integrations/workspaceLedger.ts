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
import { spawn } from "node:child_process";
import { hunchPaths } from "../core/paths.js";
import { readConfig, workspacesConfig, type WorkspacesConfig } from "../core/config.js";
import { loadOrCreateMachine, type MachineIdentity } from "../core/machine.js";
import {
  ago, branchRows, latestPerMachine, isUnverified, sameWorkspaceContent, worktreeRows,
  type BranchRow, type Workspace, type WorktreeRow,
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
  store.putCapture("workspaces", record, isPrivate);
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
    r.merged.status === "merged" ? `yes (${r.merged.method})` : r.merged.status === "unmerged" ? "no" : "unknown",
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
