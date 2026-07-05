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
