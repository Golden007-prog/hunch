import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../src/core/types.js";
import { tempStore } from "./helpers.js";
import { renderGrounding } from "../src/core/topics.js";

function dec(over: Partial<Decision>): Decision {
  return {
    id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [],
    related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2025-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2025-01-01T00:00:00Z",
    ...over,
  };
}

test("end-to-end: assembleContext surfaces an anchored decision, and grounding frames it (the hook path)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", dec({
    id: "dec_gql", topic: "auth-transport", title: "Public API transport",
    decision: "Use GraphQL for the public API", alternatives_rejected: ["REST"],
    related_files: ["api/schema.ts"],
  }));
  // The PreToolUse hook path: what Hunch knows about the edited file.
  const ctx = store.assembleContext("api/schema.ts");
  assert.ok(ctx.decisions.some((d) => d.id === "dec_gql"), "the anchored decision is in scope of the file");
  const grounding = renderGrounding(ctx.decisions);
  assert.match(grounding, /auth-transport/);
  assert.match(grounding, /Use GraphQL for the public API/);
  assert.match(grounding, /rejected: REST/);
});
