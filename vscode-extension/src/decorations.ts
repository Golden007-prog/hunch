/**
 * Overview-ruler + gutter marks for symbols carrying bug/fragility signal, so
 * hotspots are scannable from the scrollbar (complements the CodeLens text).
 * Ranges come from the language server (symbols have no .hunch line info).
 */
import * as vscode from "vscode";
import { symbolRanges } from "./providers.js";
import { symbolSignals, type Hunch } from "./hunchData.js";

type GetHunch = () => Hunch | null;
type RelPath = (file: string) => string;

export class HunchDecorations {
  // bug-bearing symbols: red ruler mark; fragile-only: orange.
  private bug = vscode.window.createTextEditorDecorationType({
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    isWholeLine: false,
  });
  private fragile = vscode.window.createTextEditorDecorationType({
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    isWholeLine: false,
  });

  constructor(private getHunch: GetHunch, private rel: RelPath) {}

  async update(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) return;
    const cfg = vscode.workspace.getConfiguration("hunch");
    if (!cfg.get("decorations.enabled", true)) {
      editor.setDecorations(this.bug, []);
      editor.setDecorations(this.fragile, []);
      return;
    }
    const hunch = this.getHunch();
    if (!hunch) return;
    const file = this.rel(editor.document.uri.fsPath);
    const signals = symbolSignals(hunch, file);
    if (!signals.size) {
      editor.setDecorations(this.bug, []);
      editor.setDecorations(this.fragile, []);
      return;
    }
    const ranges = await symbolRanges(editor.document.uri);
    const bugMarks: vscode.DecorationOptions[] = [];
    const fragileMarks: vscode.DecorationOptions[] = [];
    for (const [name, sig] of signals) {
      const r = ranges.get(name);
      if (!r) continue;
      const opt: vscode.DecorationOptions = { range: r, hoverMessage: `🧠 Hunch — ${sig.evidence}` };
      (sig.bugCount > 0 ? bugMarks : fragileMarks).push(opt);
    }
    editor.setDecorations(this.bug, bugMarks);
    editor.setDecorations(this.fragile, fragileMarks);
  }

  dispose(): void { this.bug.dispose(); this.fragile.dispose(); }
}
