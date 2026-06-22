import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import type { Symbol as SymbolRec } from "../src/core/types.js";
import type { HunchStore } from "../src/store/hunchStore.js";

/** Seed a top-level symbol into the graph (JSON source of truth). */
function sym(store: HunchStore, id: string, file: string, name: string, kind = "function"): void {
  store.json.put("symbols", {
    id, file, name, kind,
    signature_hash: "", calls: [], called_by: [],
    metrics: { loc: 0, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "",
  } as unknown as SymbolRec);
}

test("redundancy guard flags an added symbol that already exists in another file", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_1", "src/util/date.ts", "formatDate");
    const hits = store.redundantSymbols([{ name: "formatDate", kind: "function" }], ["src/cart.ts"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, "formatDate");
    assert.equal(hits[0]!.existingFile, "src/util/date.ts");
  } finally { cleanup(); }
});

test("redundancy guard: no false positive when the match is in a file the diff itself touches", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_1", "src/util/date.ts", "formatDate");
    // Editing the same file that defines it → that's the symbol being changed, not a dup.
    const hits = store.redundantSymbols([{ name: "formatDate", kind: "function" }], ["src/util/date.ts"]);
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: stopwords, short names, and non-top-level kinds are ignored", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_h", "src/a.ts", "handler");
    sym(store, "sym_s", "src/b.ts", "fn");
    sym(store, "sym_i", "src/c.ts", "MyType", "interface");
    const hits = store.redundantSymbols([
      { name: "handler", kind: "function" },  // stopword
      { name: "fn", kind: "function" },        // length < 4
      { name: "MyType", kind: "interface" },   // kind not in {function,class,const}
    ], ["src/x.ts"]);
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: an existing METHOD or file node of the same name is not a re-implementation", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_m", "src/widget.ts", "refresh", "method"); // a class method
    sym(store, "sym_f", "src/refresh.ts", "refresh", "file");   // the file node
    const hits = store.redundantSymbols([{ name: "refresh", kind: "function" }], ["src/x.ts"]);
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: a match in a different top-level root (test/, vscode-extension/) is not sprawl", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_t", "test/helper.ts", "computeThing");
    sym(store, "sym_v", "vscode-extension/src/x.ts", "computeThing");
    // A src/ change colliding with a test fixture or a separate sub-project is not a re-impl.
    const hits = store.redundantSymbols([{ name: "computeThing", kind: "function" }], ["src/feature.ts"]);
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: a sub-threshold move (Add new path, Delete old path) is not a duplicate", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_old", "src/old/cart.ts", "computeTotal");
    // The diff adds computeTotal at the new path and deletes the old path (movedFrom).
    const hits = store.redundantSymbols(
      [{ name: "computeTotal", kind: "function" }],
      ["src/new/cart.ts"],
      { movedFrom: ["src/old/cart.ts"] },
    );
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: a name also removed in the same diff is treated as moved, not duplicated", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_old", "src/old/cart.ts", "computeTotal");
    const hits = store.redundantSymbols(
      [{ name: "computeTotal", kind: "function" }],
      ["src/new/cart.ts"],
      { removedNames: new Set(["computeTotal"]) },
    );
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: no hit when the name exists nowhere else", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_1", "src/util/date.ts", "formatDate");
    const hits = store.redundantSymbols([{ name: "parseInvoice", kind: "function" }], ["src/cart.ts"]);
    assert.equal(hits.length, 0);
  } finally { cleanup(); }
});

test("redundancy guard: dedupes repeated added names", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_1", "src/util/date.ts", "formatDate");
    const hits = store.redundantSymbols([
      { name: "formatDate", kind: "function" },
      { name: "formatDate", kind: "function" },
    ], ["src/cart.ts"]);
    assert.equal(hits.length, 1);
  } finally { cleanup(); }
});

test("redundancy guard: empty added list returns nothing (cheap exit)", () => {
  const { store, cleanup } = tempStore();
  try {
    sym(store, "sym_1", "src/util/date.ts", "formatDate");
    assert.deepEqual(store.redundantSymbols([], ["src/cart.ts"]), []);
  } finally { cleanup(); }
});
