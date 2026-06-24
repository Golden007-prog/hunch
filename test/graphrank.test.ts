import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";

/** Minimal symbol record (mirrors the indexer's shape) for graph-stream tests. */
const SYM = (id: string, name: string, file: string) => ({
  id, file, name, kind: "function", signature_hash: "sha1:test",
  calls: [], called_by: [],
  metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
  last_changed: "commit:test",
});

const EDGE = (from: string, to: string) => ({
  id: `edge_${from}_${to}`, from, to, type: "calls",
  reason: `${from} calls ${to}`, strength: 0.8, provenance: prov(0.8),
});

test("graph stream: a 1-hop dependency neighbor surfaces via hybridSearch though pure FTS misses it (roadmap #1)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Disjoint names so a keyword query for one can't lexically match the other.
  store.json.put("symbols", SYM("sym_alpha", "alphazoomwidget", "src/a.ts") as never);
  store.json.put("symbols", SYM("sym_beta", "betaquuxhandler", "src/b.ts") as never);
  store.json.put("edges", EDGE("sym_alpha", "sym_beta") as never); // alpha → beta dependency
  store.reindex();

  // precondition: keyword search reaches the seed, never the neighbor.
  const fts = store.search("alphazoomwidget", 12).map((h) => h.ref);
  assert.ok(fts.includes("sym_alpha"), "fts finds the queried symbol");
  assert.ok(!fts.includes("sym_beta"), "fts cannot reach the neighbor lexically");

  // the graph stream expands 1 hop and surfaces the neighbor — no embeddings needed.
  const hits = (await store.hybridSearch("alphazoomwidget", 12)).map((h) => h.ref);
  assert.ok(hits.includes("sym_alpha"), "seed still present after fusion");
  assert.ok(hits.includes("sym_beta"), "1-hop neighbor surfaced via the graph stream");
});

test("graph stream: a hop also walks BACKWARD (a caller of the seed surfaces)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_caller", "outerzappframe", "src/c.ts") as never);
  store.json.put("symbols", SYM("sym_target", "innerblorptask", "src/d.ts") as never);
  store.json.put("edges", EDGE("sym_caller", "sym_target") as never); // caller → target
  store.reindex();

  const hits = (await store.hybridSearch("innerblorptask", 12)).map((h) => h.ref);
  assert.ok(hits.includes("sym_caller"), "the seed's caller surfaced via a backward 1-hop");
});

test("graph stream: no edges ⇒ hybridSearch equals pure FTS (no spurious neighbors)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_lonely", "solofuncname", "src/e.ts") as never);
  store.reindex();

  const fts = store.search("solofuncname", 12).map((h) => h.ref);
  const hits = (await store.hybridSearch("solofuncname", 12)).map((h) => h.ref);
  assert.deepEqual(hits, fts, "with no graph signal the fast path returns pure FTS");
});
