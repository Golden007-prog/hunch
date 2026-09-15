/** Native lifecycle coverage is independent of whether a model follows reporting
 * instructions. Only an authoritative prompt identity may join its evidence. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookProvider, HunchHookInput } from "./agenthook.js";
import { findRoot } from "./paths.js";
import { canonicalReportRoot } from "./taskReportPaths.js";
import { isCredentialFreeText } from "./types.js";
import { isEmptyTaskReport, readTaskReport, recordReportRefusal, reportHash, reportPresentationEnabled, startReportTask } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { renderTaskReport } from "./taskReportRender.js";

/** The exact task identity a native host prompt maps to. */
export function promptTaskId(root: string, sessionId: string, promptId: string, agentId: string | null = null, provider: HookProvider = "claude"): string {
  return `htask_${reportHash([canonicalReportRoot(root), provider, sessionId, promptId, agentId]).slice(7, 31)}`;
}

/** Hosts whose hooks deliver a native per-prompt identity (Claude Code's
 * prompt_id, Codex's turn_id). Others get no task from a hook. */
const NATIVE_PROMPT_HOSTS: ReadonlySet<HookProvider> = new Set<HookProvider>(["claude", "codex"]);
const NATIVE_TASK_TITLE = "Assistant task";
const GENERIC_TASK_TITLES: ReadonlySet<string> = new Set(["Assistant task", "Claude task"]);
const TASK_TITLE_MAX = 72;

/** Prompt-derived titles are OPT-IN (`"taskTitles": "prompt"` in .hunch/local.json).
 * The default keeps the documented guarantee that no prompt text is retained
 * anywhere: not in the ledger, the Stop card, the Contribution view, nor a graph
 * record that may be committed to a public repository. */
export function promptTitlesEnabled(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")).taskTitles === "prompt"; }
  catch { return false; }
}

/** A short, safe task title from the prompt's first line: control characters
 * and runs of whitespace collapse, credential-looking text is refused, and the
 * result is cut at a word boundary. Null means "use the generic title". The
 * title is the only prompt-derived prose that reaches the ledger and, on
 * finish, the graph record. */
export function promptTaskTitle(prompt: string | undefined): string | null {
  if (typeof prompt !== "string") return null;
  const firstLine = prompt.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? "";
  const clean = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 3 || !isCredentialFreeText(clean) || !isCredentialFreeText(prompt.slice(0, 4096))) return null;
  if (clean.length <= TASK_TITLE_MAX) return clean;
  const cut = clean.slice(0, TASK_TITLE_MAX);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > TASK_TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** Carry a hook-observed working directory into MCP only after proving it names
 * the same physical repository as the hook process. The canonical repository
 * root is stable across cwd subdirectories and safe to copy into a tool call. */
export function nativeHookCwd(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (!NATIVE_PROMPT_HOSTS.has(provider) || !event.cwd) return null;
  try {
    const physicalRoot = canonicalReportRoot(root);
    return canonicalReportRoot(findRoot(event.cwd)) === physicalRoot ? physicalRoot : null;
  } catch {
    return null;
  }
}

function identity(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (!nativeHookCwd(root, provider, event)) return null;
  for (const value of [event.session_id, event.prompt_id, event.agent_id]) {
    if (value !== undefined && (!value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))) return null;
  }
  if (!event.session_id) return null;
  if (!event.prompt_id) return "legacy";
  return promptTaskId(root, event.session_id, event.prompt_id, event.agent_id ?? null, provider);
}

export function hookReportTaskId(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  try {
    const id = identity(root, provider, event);
    return id === "legacy" ? null : id;
  } catch { return null; }
}

/** Every prompt receives its exact ID, even when ambient reminders were deduped.
 * No raw prompt, host session identifier, or transcript is retained; a repository
 * that opts in (`taskTitles: "prompt"`) keeps only a bounded first-line title. */
export function startHookReport(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  const id = identity(root, provider, event);
  if (!id || id === "legacy") return null;
  // Re-resolve after identity validation and fail closed if the filesystem
  // changed between the two reads; never emit a task instruction with cwd:null.
  const cwd = nativeHookCwd(root, provider, event);
  if (!cwd) return null;
  const cwdLiteral = JSON.stringify(cwd);
  const title = (promptTitlesEnabled(root) ? promptTaskTitle(event.prompt) : null) ?? NATIVE_TASK_TITLE;
  let task: ReturnType<typeof startReportTask>;
  try { task = startReportTask(root, title, id); }
  catch (error) {
    // The same prompt identity may already be open: a release that called every
    // native task "Claude task"/"Assistant task", or a second hook registration
    // for the same host. The persisted identity and title win; never a second task.
    const existing = readTaskReport(root, id).task;
    if (existing.title !== title && !GENERIC_TASK_TITLES.has(existing.title) && !GENERIC_TASK_TITLES.has(title)) throw error;
    task = existing;
  }
  return `Hunch has opened this prompt's report: ${task.task_id}. Reuse this exact ID for this prompt. Call hunch_task(action: "start", task_id: "${task.task_id}", title: ${JSON.stringify(task.title)}, cwd: ${cwdLiteral}) to obtain verification_argv; do not create another report. Pass this task_id and cwd: ${cwdLiteral} to hunch_context and decision/correction/finding captures, and pass the same cwd when finishing with hunch_task before responding. A host Stop notice will show the evidence even if no task-linked memory was observed.`;
}

/** A presentation notice never denies Stop or injects another model turn. Stop
 * can precede another hook's continuation, so it does not close an open task.
 * A prompt with no observation at all prints nothing: the empty task row stays
 * in the ledger (hunch task list, the VS Code Contribution view) so "never
 * touched Hunch" remains countable without a five-line notice per prompt. */
export function stopHookReport(root: string, provider: HookProvider, event: HunchHookInput): { systemMessage: string } | null {
  if (!reportPresentationEnabled(root)) return null;
  const id = identity(root, provider, event);
  if (!id) return null;
  if (id === "legacy") return { systemMessage: "Hunch hook active. This host version does not provide an exact prompt identifier, so contribution for this response is unverified. Explicit task reports remain available with hunch report." };
  try {
    const report = readTaskReport(root, id, reportSourceSnapshot(root).hash);
    if (isEmptyTaskReport(report)) return null;
    // The HTML evidence view is a rendering of the local ledger, generated on
    // demand (`hunch report <id> --html`, or a click in the VS Code view). The
    // graph record is the durable memory; no file is written per prompt.
    return { systemMessage: renderTaskReport(report) };
  } catch {
    return { systemMessage: `Hunch report unavailable for ${id}. Contribution is unverified; inspect with hunch report ${id}.` };
  }
}

/** Call only after emitting the native denial. Evidence failures must never
 * suppress the gate response or attach it to a guessed task. */
export function observeHookDenial(root: string, provider: HookProvider, event: HunchHookInput, target: string, denial: { reason: string; event: { kind: "constraint" | "veto"; constraint?: string; decision?: string } }): void {
  try {
    const taskId = hookReportTaskId(root, provider, event);
    const recordId = denial.event.kind === "constraint" ? denial.event.constraint : denial.event.decision;
    if (!taskId || !recordId) return;
    recordReportRefusal(root, taskId, { source: "native-edit-gate", outcome: "denial-emitted", kind: denial.event.kind, record_id: recordId, target, reason_hash: reportHash(denial.reason) });
  } catch { /* the already emitted gate response remains authoritative */ }
}
