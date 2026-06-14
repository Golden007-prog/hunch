/**
 * Project Brain — VS Code extension. A read-only visualizer over the committed
 * .brain/ JSON: a tree of decisions/invariants/bugs/fragility, "why is this file
 * the way it is?" + context briefs, and a status-bar invariant counter for the
 * active file. Pairs with the Claude Code chat (which uses the brain MCP tools).
 */
import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as nodePath from "node:path";
import {
  loadBrain, why, fragileSymbols, constraintsInScope, isStale, sevRank,
  type Brain, type Provenance,
} from "./brainData.js";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function relPath(file: string): string {
  const root = workspaceRoot();
  if (!root) return file;
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** git author-date (ms) of the last commit touching a file; 0 if unknown. */
function lastChangeMs(root: string, file: string): number {
  try {
    const out = cp.execFileSync("git", ["log", "-1", "--format=%aI", "--", file], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? Date.parse(out) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------
type Node =
  | { kind: "group"; label: string; key: string }
  | { kind: "leaf"; label: string; description?: string; tooltip?: string; file?: string };

class BrainTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private brain: Brain | null = null;

  refresh(): void {
    const root = workspaceRoot();
    this.brain = root ? loadBrain(root) : null;
    this._onDidChange.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "group") {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[n.key] ?? "circle-outline");
      return item;
    }
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.description = n.description;
    item.tooltip = n.tooltip ?? n.label;
    if (n.file) {
      item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(n.file)] };
      item.resourceUri = vscode.Uri.file(n.file);
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    const b = this.brain;
    if (!b) return node ? [] : [{ kind: "leaf", label: "No .brain/ found — run `brain init`" }];
    if (!node) {
      return [
        { kind: "group", label: `Invariants (${b.constraints.length})`, key: "constraints" },
        { kind: "group", label: `Decisions (${b.decisions.length})`, key: "decisions" },
        { kind: "group", label: `Bugs (${b.bugs.length})`, key: "bugs" },
        { kind: "group", label: `Fragile symbols`, key: "fragile" },
        { kind: "group", label: `Components (${b.components.length})`, key: "components" },
      ];
    }
    if (node.kind !== "group") return [];
    const root = b.root;
    switch (node.key) {
      case "constraints":
        return [...b.constraints].sort((x, y) => sevRank(y.severity) - sevRank(x.severity)).map((c) => ({
          kind: "leaf", label: `[${c.severity}] ${c.statement}`,
          description: prov(c.provenance) + (isStale(c, (f) => lastChangeMs(root, f)) ? " ⚠stale" : ""),
          tooltip: `${c.id}\nscope: ${(c.scope ?? []).join(", ")}\n${c.rationale ?? ""}`,
        }));
      case "decisions":
        return b.decisions.map((d) => ({
          kind: "leaf", label: `[${d.status}] ${d.title}`,
          description: prov(d.provenance) + (isStale(d, (f) => lastChangeMs(root, f)) ? " ⚠stale" : ""),
          tooltip: `${d.id}\n${d.decision ?? ""}`,
          file: firstFile(root, d.related_files),
        }));
      case "bugs":
        return b.bugs.map((bug) => ({
          kind: "leaf", label: `[${bug.severity}/${bug.status}] ${bug.title}`,
          description: prov(bug.provenance),
          tooltip: `${bug.id}\nsymptom: ${bug.symptom ?? ""}\nroot cause: ${bug.root_cause ?? ""}`,
          file: firstFile(root, bug.affected_files),
        }));
      case "fragile":
        return fragileSymbols(b).map((s) => ({
          kind: "leaf", label: `${s.score.toFixed(2)}  ${s.name}`,
          description: s.evidence, tooltip: `${s.name} @ ${s.file}\n${s.evidence}`,
          file: absFile(root, s.file),
        }));
      case "components":
        return b.components.map((c) => ({
          kind: "leaf", label: c.name,
          description: (c.fragility ? `fragility ${c.fragility}` : "") + ` ${(c.paths ?? []).join(", ")}`,
          tooltip: `${c.id}\n${c.responsibility ?? ""}`,
        }));
      default:
        return [];
    }
  }
}

const GROUP_ICONS: Record<string, string> = {
  constraints: "shield", decisions: "lightbulb", bugs: "bug", fragile: "flame", components: "package",
};

function prov(p?: Provenance): string {
  if (!p) return "";
  return `${p.source ?? "?"} ${p.confidence ?? "?"}`;
}
function firstFile(root: string, files?: string[]): string | undefined {
  return files && files.length ? absFile(root, files[0]!) : undefined;
}
function absFile(root: string, f: string): string {
  return nodePath.isAbsolute(f) ? f : nodePath.join(root, f);
}

// ---------------------------------------------------------------------------
// Webview brief (why / context)
// ---------------------------------------------------------------------------
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function showBrief(title: string, sections: Array<{ h: string; lines: string[] }>): void {
  const panel = vscode.window.createWebviewPanel("brainBrief", title, vscode.ViewColumn.Beside, {});
  const body = sections
    .filter((s) => s.lines.length)
    .map((s) => `<h3>${esc(s.h)}</h3><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`)
    .join("");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);padding:0 16px;color:var(--vscode-foreground)}
    h2{border-bottom:1px solid var(--vscode-panel-border)} h3{margin-top:1.2em}
    li{margin:.3em 0;line-height:1.4} code{color:var(--vscode-textPreformat-foreground)}
  </style></head><body><h2>${esc(title)}</h2>${body || "<p><em>The Brain has nothing recorded for this yet — it is still learning this file.</em></p>"}</body></html>`;
}

function whyBrief(brain: Brain, file: string): void {
  const w = why(brain, file);
  showBrief(`🧠 Why: ${relPath(file)}`, [
    { h: "⛔ Invariants (must not break)", lines: w.constraints.map((c) => `[${c.severity}] ${c.statement}  (${c.id})`) },
    { h: "🧭 Decisions", lines: w.decisions.map((d) => `[${d.status}] ${d.title} — ${d.decision ?? ""}`) },
    { h: "🐞 Bug history", lines: w.bugs.map((b) => `[${b.severity}] ${b.title} — root cause: ${b.root_cause ?? ""}`) },
    { h: "💥 Blast radius (dependents)", lines: w.dependents.map((d) => `${d.name} @ ${relPath(d.file)}`) },
  ]);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function updateStatusBar(item: vscode.StatusBarItem): void {
  const cfg = vscode.workspace.getConfiguration("brain");
  const editor = vscode.window.activeTextEditor;
  const root = workspaceRoot();
  if (!cfg.get("statusBar.enabled", true) || !editor || !root) {
    item.hide();
    return;
  }
  const brain = loadBrain(root);
  if (!brain) {
    item.hide();
    return;
  }
  const file = relPath(editor.document.uri.fsPath);
  const cons = constraintsInScope(brain, file);
  if (!cons.length) {
    item.text = "$(shield) Brain";
    item.tooltip = "No invariants for this file";
  } else {
    const blocking = cons.filter((c) => c.severity === "blocking").length;
    item.text = `$(shield)${blocking ? "$(warning)" : ""} ${cons.length} invariant${cons.length > 1 ? "s" : ""}`;
    item.tooltip = new vscode.MarkdownString(cons.map((c) => `- **[${c.severity}]** ${c.statement}`).join("\n"));
  }
  item.command = "brain.why";
  item.show();
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  const tree = new BrainTree();
  tree.refresh();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("brain.tree", tree));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);

  const activeFile = (): string | undefined => vscode.window.activeTextEditor?.document.uri.fsPath;
  const withBrain = (fn: (b: Brain, file: string) => void) => {
    const root = workspaceRoot();
    const file = activeFile();
    const brain = root ? loadBrain(root) : null;
    if (!brain) return void vscode.window.showWarningMessage("No Project Brain (.brain/) found — run `brain init`.");
    if (!file) return void vscode.window.showWarningMessage("Open a file first.");
    fn(brain, relPath(file));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("brain.refresh", () => {
      tree.refresh();
      updateStatusBar(status);
    }),
    vscode.commands.registerCommand("brain.why", () => withBrain((b, f) => whyBrief(b, f))),
    vscode.commands.registerCommand("brain.context", () =>
      withBrain((b, f) => {
        const w = why(b, f);
        showBrief(`🧠 Context: ${f}`, [
          { h: "⛔ Invariants", lines: w.constraints.map((c) => `[${c.severity}] ${c.statement}`) },
          { h: "🧭 Decisions", lines: w.decisions.map((d) => d.title) },
          { h: "🐞 Bugs", lines: w.bugs.map((bug) => bug.title) },
          { h: "💥 Blast radius", lines: w.dependents.map((d) => `${d.name} @ ${relPath(d.file)}`) },
        ]);
      }),
    ),
  );

  // live refresh when the Brain changes on disk
  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".brain/**/*.json"));
    const onChange = () => {
      tree.refresh();
      updateStatusBar(status);
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(status)));
  updateStatusBar(status);
}

export function deactivate(): void {
  /* nothing to clean up */
}
