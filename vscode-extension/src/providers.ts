/**
 * In-editor providers (CodeLens + Hover) over the Hunch graph.
 *
 * .hunch symbols carry no source ranges, so we resolve a symbol-name → range
 * map per document from the language server (executeDocumentSymbolProvider).
 * That keeps the extension a pure reader of .hunch while still placing marks on
 * the right lines, and it degrades to nothing when no language server answers.
 */
import * as vscode from "vscode";
import {
  why, symbolSignals, bugsForSymbol, nearConstraints,
  type Hunch, type SymbolSignal,
} from "./hunchData.js";

type GetHunch = () => Hunch | null;
type RelPath = (file: string) => string;

/** Flatten the (possibly hierarchical) document symbols into a name → range map.
 *  First declaration of a name wins. Returns an empty map if nothing answers. */
export async function symbolRanges(uri: vscode.Uri): Promise<Map<string, vscode.Range>> {
  const out = new Map<string, vscode.Range>();
  let syms: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
  try {
    syms = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
  } catch {
    return out;
  }
  if (!syms?.length) return out;
  const walk = (s: vscode.DocumentSymbol): void => {
    const range = s.selectionRange ?? s.range;
    if (!out.has(s.name)) out.set(s.name, range);
    s.children?.forEach(walk);
  };
  for (const s of syms) {
    if ("children" in s) walk(s as vscode.DocumentSymbol);
    else if (!out.has(s.name)) out.set(s.name, (s as vscode.SymbolInformation).location.range);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CodeLens: one file-level lens (counts + "Why?") plus one lens per symbol that
// carries bug/fragility signal.
// ---------------------------------------------------------------------------
export class HunchCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  constructor(private getHunch: GetHunch, private rel: RelPath) {}
  refresh(): void { this._onDidChange.fire(); }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const cfg = vscode.workspace.getConfiguration("hunch");
    if (!cfg.get("codeLens.enabled", true)) return [];
    const hunch = this.getHunch();
    if (!hunch) return [];
    const file = this.rel(doc.uri.fsPath);
    const w = why(hunch, file);
    const near = nearConstraints(hunch, file);
    const lenses: vscode.CodeLens[] = [];

    // file-level summary at the top of the file
    const parts = [
      w.constraints.length && `⛔ ${w.constraints.length} invariant${w.constraints.length === 1 ? "" : "s"}`,
      near.length && `⚠ ${near.length} near`,
      w.decisions.length && `🧭 ${w.decisions.length} decision${w.decisions.length === 1 ? "" : "s"}`,
      w.bugs.length && `🐞 ${w.bugs.length} bug${w.bugs.length === 1 ? "" : "s"}`,
    ].filter(Boolean);
    if (parts.length) {
      lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `🧠 Hunch — ${parts.join(" · ")}`,
        command: "hunch.why",
        tooltip: "Open the full Hunch brief for this file",
      }));
    }

    // per-symbol lenses (only when there is signal worth resolving ranges for)
    const signals = symbolSignals(hunch, file);
    if (signals.size) {
      const ranges = await symbolRanges(doc.uri);
      for (const [name, sig] of signals) {
        const range = ranges.get(name);
        if (!range) continue;
        lenses.push(new vscode.CodeLens(range, {
          title: symbolLensTitle(sig),
          command: "hunch.whySymbol",
          arguments: [name],
          tooltip: sig.evidence,
        }));
      }
    }
    return lenses;
  }
}

function symbolLensTitle(sig: SymbolSignal): string {
  const bits = [
    sig.bugCount > 0 && `🐞 ${sig.bugCount} bug${sig.bugCount === 1 ? "" : "s"}`,
    sig.fragility >= 0.15 && `🔥 fragile ${sig.fragility.toFixed(2)}`,
  ].filter(Boolean);
  return `Hunch: ${bits.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Hover: invariants/decisions/bugs/blast-radius for the symbol under the cursor.
// ---------------------------------------------------------------------------
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
