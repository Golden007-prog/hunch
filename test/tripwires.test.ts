import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { draftTripwires } from "../src/synthesis/tripwires.js";
import { analyzeDiff } from "../src/extractors/diff.js";
import type { Decision } from "../src/core/types.js";

test("draftTripwires: scope = dir globs of related files, deps from prose, backticked symbols, always llm_draft", () => {
  const tws = draftTripwires(
    ["have the extension call axios against the API", "wrap it in a `fetchHelper`"],
    ["vscode-extension/src/extension.ts", "vscode-extension/src/data.ts"],
    ["axios", "node-fetch"],
  );
  assert.equal(tws.length, 2);
  assert.deepEqual(tws[0]!.scope, ["vscode-extension/src/**"], "directory glob, deduped");
  assert.deepEqual(tws[0]!.forbids.deps, ["axios"], "named dep recognized; node-fetch not mentioned");
  assert.deepEqual(tws[1]!.forbids.symbols, ["fetchHelper"], "backticked identifier → candidate symbol");
  assert.equal(tws[0]!.provenance.source, "llm_draft", "draft → advisory until confirmed");
});

test("draftTripwires: dep match is whole-token (axios ≠ axiosClient, handles hyphens)", () => {
  const a = draftTripwires(["use axios here"], ["src/a.ts"], ["axios"]);
  assert.deepEqual(a[0]!.forbids.deps, ["axios"]);
  const b = draftTripwires(["use axiosClient here"], ["src/a.ts"], ["axios"]);
  assert.deepEqual(b[0]!.forbids.deps, [], "substring inside a larger identifier must not match");
  const c = draftTripwires(["switch to node-fetch"], ["src/a.ts"], ["node-fetch"]);
  assert.deepEqual(c[0]!.forbids.deps, ["node-fetch"], "hyphenated dep name matches");
});

// The progressive-enforcement chain: a drafted tripwire WARNS; confirming it BLOCKS.
function mkDecision(over: Partial<Decision> & { id: string }): Decision {
  return {
    title: "Read-only layer", status: "accepted", context: "", decision: "read committed JSON",
    consequences: [], alternatives_rejected: ["extension queries axios"], rejected_tripwires: [],
    related_components: [], related_files: ["vscode-extension/src/extension.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const EXT = "vscode-extension/src/extension.ts";

test("progressive enforcement: a backfilled draft warns; promoting it to human_confirmed blocks", () => {
  const { store, cleanup } = tempStore();
  try {
    // backfill-shaped draft: dep axios recognized from the alternative prose
    const drafted = draftTripwires(["extension queries axios"], [EXT], ["axios"]);
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: drafted }));

    const advisory = store.vetoForFileEdit(EXT, ['import axios from "axios";']);
    assert.equal(advisory.length, 1, "draft still surfaces");
    assert.equal(advisory[0]!.blocks, false, "llm_draft tripwire is advisory, never blocks");

    // confirm the tripwire (what `hunch review --accept` does)
    const confirmed = drafted.map((tw) => ({ ...tw, provenance: { ...tw.provenance, source: "llm_draft+human_confirmed" } }));
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: confirmed }));

    const blocked = store.vetoForFileEdit(EXT, ['import axios from "axios";']);
    assert.equal(blocked[0]!.blocks, true, "confirmed tripwire now fails the edit");
  } finally {
    cleanup();
  }
});

test("draftTripwires produces an inert (never-matching) tripwire when prose names nothing checkable", () => {
  const tws = draftTripwires(["do it a totally different way"], ["src/a.ts"], ["axios"]);
  assert.deepEqual(tws[0]!.forbids, { deps: [], symbols: [], patterns: [] });
  // an empty forbids matches nothing — confirms it cannot cause a false block
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_x", related_files: ["src/a.ts"], rejected_tripwires: tws.map((t) => ({ ...t, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } })) }));
    assert.equal(store.vetoForFileEdit("src/a.ts", ['import axios from "axios";']).length, 0, "inert tripwire never matches");
    // sanity: analyzeDiff still sees the dep, so the no-match is the tripwire's doing
    assert.ok(analyzeDiff('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+import axios from "axios";').addedDeps.includes("axios"));
  } finally {
    cleanup();
  }
});
