/**
 * Command-palette fuzzy search across every Hunch record (the local, offline
 * analog of hunch_query). Live-updates results as you type; accepting a hit
 * opens its primary file, or shows its detail when it has none.
 */
import * as vscode from "vscode";
import * as nodePath from "node:path";
import { searchAll, type Hunch, type SearchHit } from "./hunchData.js";

const ICON: Record<SearchHit["kind"], string> = {
  constraint: "$(shield)", decision: "$(lightbulb)", bug: "$(bug)", component: "$(package)",
};

interface Item extends vscode.QuickPickItem { hit: SearchHit; }

export function runSearch(hunch: Hunch, root: string): void {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = "Search Hunch — decisions, invariants, bugs, components";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const toItems = (q: string): Item[] =>
    searchAll(hunch, q).map((hit) => ({
      label: `${ICON[hit.kind]} ${hit.label}`,
      description: hit.kind,
      detail: hit.detail || hit.file || "",
      hit,
    }));

  qp.onDidChangeValue((v) => { qp.items = toItems(v); });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (!pick) return;
    const { hit } = pick;
    if (hit.file) {
      const abs = nodePath.isAbsolute(hit.file) ? hit.file : nodePath.join(root, hit.file);
      vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs)).then(undefined, () =>
        vscode.window.showInformationMessage(`${hit.id}: ${hit.label}\n${hit.detail}`, { modal: true }));
    } else {
      vscode.window.showInformationMessage(`${hit.id}: ${hit.label}`, { modal: true, detail: hit.detail });
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
