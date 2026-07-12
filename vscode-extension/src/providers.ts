/**
 * In-editor hover over the Hunch graph: bug history + fragility for the symbol
 * under the cursor, with a deep-link into the full brief. A pure reader of
 * .hunch; degrades to nothing when the graph has no signal for the symbol.
 */
import * as vscode from "vscode";
import { symbolSignals, bugsForSymbol, type Hunch } from "./hunchData.js";

type GetHunch = () => Hunch | null;
type RelPath = (file: string) => string;

export class HunchHoverProvider implements vscode.HoverProvider {
  constructor(private getHunch: GetHunch, private rel: RelPath) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const cfg = vscode.workspace.getConfiguration("hunch");
    if (!cfg.get("hover.enabled", true)) return undefined;
    const hunch = this.getHunch();
    if (!hunch) return undefined;
    const wordRange = doc.getWordRangeAtPosition(pos);
    if (!wordRange) return undefined;
    const name = doc.getText(wordRange);
    const file = this.rel(doc.uri.fsPath);

    const sigs = symbolSignals(hunch, file);
    const sig = sigs.get(name);
    const symBugs = bugsForSymbol(hunch, file, name);
    if (!sig && !symBugs.length) return undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**🧠 Hunch — \`${name}\`**\n\n`);
    if (sig) md.appendMarkdown(`${sig.bugCount > 0 ? "🐞 " : "🔥 "}${sig.evidence}\n\n`);
    for (const b of symBugs.slice(0, 5)) {
      md.appendMarkdown(`- 🐞 **[${b.severity}/${b.status}]** ${b.title}`);
      if (b.root_cause) md.appendMarkdown(` — _root cause:_ ${b.root_cause}`);
      md.appendMarkdown("\n");
    }
    md.appendMarkdown(`\n[Open Hunch brief](command:hunch.whySymbol?${encodeURIComponent(JSON.stringify([name]))})`);
    return new vscode.Hover(md, wordRange);
  }
}
