/**
 * Surfaces Hunch invariants for the active file into the Problems panel as
 * diagnostics — so an invariant you might break is visible while you edit, not
 * only when you open the tree. File-scoped (constraints have no line ranges),
 * so all marks sit on the first line. Read-only: never edits the document.
 */
import * as vscode from "vscode";
import { constraintsInScope, nearConstraints, type Hunch } from "./hunchData.js";

type GetHunch = () => Hunch | null;
type RelPath = (file: string) => string;

const SEV: Record<string, vscode.DiagnosticSeverity> = {
  blocking: vscode.DiagnosticSeverity.Warning,
  warning: vscode.DiagnosticSeverity.Information,
};

export class HunchDiagnostics {
  private col = vscode.languages.createDiagnosticCollection("hunch");
  constructor(private getHunch: GetHunch, private rel: RelPath) {}

  update(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const cfg = vscode.workspace.getConfiguration("hunch");
    const uri = editor.document.uri;
    if (!cfg.get("diagnostics.enabled", true)) { this.col.delete(uri); return; }
    const hunch = this.getHunch();
    if (!hunch) { this.col.delete(uri); return; }

    const file = this.rel(uri.fsPath);
    const firstLine = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
    const diags: vscode.Diagnostic[] = [];

    for (const c of constraintsInScope(hunch, file)) {
      const d = new vscode.Diagnostic(firstLine, `⛔ Invariant [${c.severity}]: ${c.statement}`, SEV[c.severity ?? ""] ?? vscode.DiagnosticSeverity.Information);
      d.source = "Hunch";
      d.code = c.id;
      diags.push(d);
    }
    for (const { c, via } of nearConstraints(hunch, file)) {
      const d = new vscode.Diagnostic(firstLine, `⚠ Near-invariant [${c.severity}]: ${c.statement} — reached via ${via}`, vscode.DiagnosticSeverity.Hint);
      d.source = "Hunch";
      d.code = c.id;
      diags.push(d);
    }
    this.col.set(uri, diags);
  }

  clearClosed(uri: vscode.Uri): void { this.col.delete(uri); }
  dispose(): void { this.col.dispose(); }
}
