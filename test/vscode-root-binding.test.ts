import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// The extension's view providers are deliberately exercised here. VS Code is
// only available inside the editor, so intercept the CommonJS load for this
// test's two provider imports. The hook is restored immediately afterwards;
// no repository node_modules files or global module state remain modified.
class EventEmitter {
  private readonly listeners = new Set<(value: unknown) => void>();
  readonly event = (listener: (value: unknown) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: unknown): void { for (const listener of this.listeners) listener(value); }
}
class TreeItem { constructor(public label: unknown, public collapsibleState: unknown) {} }
class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
class ThemeColor { constructor(public id: string) {} }
class MarkdownString { constructor(public value: string) {} }
const vscodeStub = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = Module._load;
let MemoryTreeProvider: typeof import("../vscode-extension/src/memoryView.js").MemoryTreeProvider;
let ContributionTreeProvider: typeof import("../vscode-extension/src/contributionView.js").ContributionTreeProvider;
try {
  Module._load = function(request, parent, isMain) {
    return request === "vscode" ? vscodeStub : originalLoad.call(this, request, parent, isMain);
  };
  ({ MemoryTreeProvider } = require("../vscode-extension/src/memoryView.ts"));
  ({ ContributionTreeProvider } = require("../vscode-extension/src/contributionView.ts"));
} finally {
  Module._load = originalLoad;
}

interface Pending {
  root: string;
  args: string[];
  resolve: (result: { ok: boolean; stdout: string; stderr: string; code: number }) => void;
}

function deferredRunner() {
  const pending: Pending[] = [];
  const run = (root: string, args: string[]) => new Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>((resolve) => {
    pending.push({ root, args, resolve });
  });
  const settle = (root: string, count: number, output: (args: string[]) => string): void => {
    const indexes = pending.map((entry, index) => entry.root === root ? index : -1).filter((index) => index >= 0).slice(0, count);
    assert.equal(indexes.length, count, `expected ${count} pending calls for ${root}`);
    for (const index of indexes.reverse()) {
      const [entry] = pending.splice(index, 1);
      entry!.resolve({ ok: true, stdout: output(entry!.args), stderr: "", code: 0 });
    }
  };
  return { run, settle };
}

function memoryOutput(args: string[]): string {
  if (args[0] === "log") return JSON.stringify([{ sha: "b", shortSha: "b", date: "2026-01-01T00:00:00Z", subject: "repo move", kind: "capture", decisionIds: [], otherIds: [], added: 1, modified: 0, deleted: 0, files: [] }]);
  return "[]";
}

function taskOutput(): string {
  return JSON.stringify([{ task: { task_id: "task-b", title: "repo task", started_at: "2026-01-01T00:00:00Z", finished_at: null, state: "completed" }, deliveries: 1, lessons: 0, claims: 0, saves: 0, refusals: 0, check: null, violated: false, coverage: "delivered", empty: false, report_html: null, error: null }]);
}

function changed(provider: { onDidChangeTreeData: (listener: () => void) => { dispose(): void } }): Promise<void> {
  return new Promise((resolve) => {
    const subscription = provider.onDidChangeTreeData(() => { subscription.dispose(); resolve(); });
  });
}

test("MemoryTreeProvider drops a slow old-root load and preserves node origins", async () => {
  let activeRoot = "/repo-a";
  const calls = deferredRunner();
  const provider = new MemoryTreeProvider(() => activeRoot, calls.run);

  const initialA = provider.getChildren();
  calls.settle("/repo-a", 3, memoryOutput);
  const nodesA = await initialA;
  assert.equal(nodesA.length, 1);
  assert.equal((nodesA[0] as { root: string }).root, "/repo-a");
  assert.equal((nodesA[0] as { command: { arguments: Array<{ root: string }> } }).command.arguments[0]!.root, "/repo-a");

  // Start a slow refresh for A, then switch folders and complete B first.
  provider.refresh();
  activeRoot = "/repo-b";
  const bChanged = changed(provider);
  provider.refresh();
  calls.settle("/repo-b", 3, memoryOutput);
  await bChanged;
  const nodesB = await provider.getChildren();
  assert.equal(nodesB.length, 1);
  assert.equal((nodesB[0] as { root: string }).root, "/repo-b");

  // A's late result is ignored, leaving B visible. The already returned A
  // node retains A as its command target even after the active folder switch.
  calls.settle("/repo-a", 3, memoryOutput);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterLateA = await provider.getChildren();
  assert.equal((afterLateA[0] as { root: string }).root, "/repo-b");
  assert.equal((nodesA[0] as { root: string }).root, "/repo-a");
});

test("ContributionTreeProvider drops a slow old-root load and stamps task origins", async () => {
  let activeRoot = "/repo-a";
  const calls = deferredRunner();
  const provider = new ContributionTreeProvider(() => activeRoot, calls.run);

  const initialA = provider.getChildren();
  calls.settle("/repo-a", 1, () => taskOutput());
  const nodesA = await initialA;
  assert.equal(nodesA.length, 1);
  assert.equal(nodesA[0]!.root, "/repo-a");
  assert.equal(nodesA[0]!.command!.arguments![0]!.root, "/repo-a");

  provider.refresh();
  activeRoot = "/repo-b";
  const bChanged = changed(provider);
  provider.refresh();
  calls.settle("/repo-b", 1, () => taskOutput());
  await bChanged;
  const nodesB = await provider.getChildren();
  assert.equal(nodesB.length, 1);
  assert.equal(nodesB[0]!.root, "/repo-b");

  calls.settle("/repo-a", 1, () => taskOutput());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await provider.getChildren())[0]!.root, "/repo-b");
  assert.equal(nodesA[0]!.root, "/repo-a");
});
