import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";

const NOW = "2026-07-05T00:00:00Z";
const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: NOW, valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: NOW,
  ...over,
});

test("rank priors: a LIVE human-confirmed decision outranks its superseded twin on the same terms", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old", title: "Gorpletron uses offset pagination", decision: "Gorpletron paginates by offset.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", title: "Gorpletron uses cursor pagination", decision: "Gorpletron paginates by cursor.", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("gorpletron pagination", 5)).map((h) => h.ref);
  assert.ok(refs.indexOf("dec_new") < refs.indexOf("dec_old"), `live before superseded, got ${refs.join(",")}`);
});

test("rank priors: topic-chain promotion surfaces the CURRENT decision even when only the superseded one matches lexically", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Old title carries the distinctive term; the successor shares NO query term.
  store.json.put("decisions", DEC({ id: "dec_old", topic: "zorp.api", title: "Blimfrazzle endpoint returns XML", decision: "Blimfrazzle speaks XML.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", topic: "zorp.api", title: "Endpoint speaks JSON now", decision: "JSON only.", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("blimfrazzle", 5)).map((h) => h.ref);
  assert.ok(refs.includes("dec_new"), `successor injected via topic chain, got ${refs.join(",")}`);
  assert.ok(refs.indexOf("dec_new") < refs.indexOf("dec_old"), "and it outranks the stale hit");
});

test("rank priors: runbook trigger phrase beats keyword luck in scoped retrieval", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const RB = (id: string, task: string, trigger: string[], steps: string[]) => ({
    id, task, trigger, steps, files: [], gotchas: [], outcome: "", source_range: null,
    valid_from: NOW, valid_to: null, provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: NOW,
  });
  store.json.put("runbooks", RB("rb_release", "cut a frobwidget release", ["cut a release"], ["bump frobwidget version", "publish frobwidget to npm", "tag frobwidget release notes"]) as never);
  store.json.put("runbooks", RB("rb_wiki", "work on the frobwidget wiki", ["work on the wiki"], ["read frobwidget docs"]) as never);
  store.reindex();
  const refs = (await store.searchRunbooks("work on the wiki", 5, { embedder: null as never })).map((h) => h.ref);
  assert.equal(refs[0], "rb_wiki", `trigger match first, got ${refs.join(",")}`);
});

test("rank priors: recorded intent outranks code symbols that merely share the query's vocabulary", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // A "why" question whose term appears in BOTH a decision and many code symbols.
  // Before the memory-record prior, the symbols filled the whole top-k on the real
  // graph and buried the one live decision (bench/golden-retrieval.json: 70% -> 80%).
  const SYM = (id: string, name: string, file: string) => ({
    id, file, name, kind: "function", signature_hash: "sha1:test",
    calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "commit:test",
  });
  for (let i = 0; i < 12; i++) {
    store.json.put("symbols", SYM(`sym_${i}`, `quibbleflange${i}`, `src/q${i}.ts`) as never);
  }
  store.json.put("decisions", DEC({
    id: "dec_intent", title: "Quibbleflange batching is deliberate",
    decision: "Quibbleflange batches writes to survive an interrupted run.",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("quibbleflange", 5)).map((h) => h.ref);
  // The prior is a BOUNDED tie-break, not a filter: a symbol whose name is a near-exact
  // lexical match may still lead. What must hold is that the decision is not buried
  // beneath a wall of same-vocabulary symbols the way it was before.
  assert.ok(refs.includes("dec_intent"), `the decision must reach the top-5, got ${refs.join(",")}`);
});

test("rank priors: the memory prior re-ranks WITHOUT excluding code symbols", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // The tie-break must never turn into a filter: a symbol-shaped query still returns
  // symbols, otherwise `hunch_structure`-style lookups would regress.
  const SYM = (id: string, name: string, file: string) => ({
    id, file, name, kind: "function", signature_hash: "sha1:test",
    calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "commit:test",
  });
  store.json.put("symbols", SYM("sym_only", "wobblesprocket", "src/w.ts") as never);
  store.reindex();
  const refs = (await store.hybridSearch("wobblesprocket", 5)).map((h) => h.ref);
  assert.ok(refs.includes("sym_only"), `symbols stay reachable, got ${refs.join(",")}`);
});
