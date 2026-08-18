import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

/**
 * Retrieval-quality floor — the golden benchmark as a release gate, not a trophy.
 *
 * The memory-record prior landed citing Recall@10 70% -> 90%. Setting this floor
 * (2026-08-19) re-measured and got 81.8%: the graph had grown under the bench in
 * one day and two wiki queries' expected records were diluted out of the top-10 —
 * exactly the silent erosion a floor exists to catch, demonstrated before the
 * floor existed. The prior's RELATIVE effect reproduced (off: 7/11, MRR 0.386;
 * on: 9/11, MRR 0.485), so the floors below are TODAY'S measured truth, not the
 * comment's high-water mark.
 *
 * If this test fails you have two honest moves: recover the ranking, or — when a
 * bench record was legitimately superseded — update bench/golden-retrieval.json
 * in the same commit that explains why. Lowering the floor is not one of them.
 */
const REPO = resolve(import.meta.dirname ?? __dirname, "..");
const BENCH = join(REPO, "bench", "golden-retrieval.json");
const RECALL_FLOOR = 9; // of 11 — measured 2026-08-19 with the memory prior on
const MRR_FLOOR = 0.45; // measured 0.485

test("golden retrieval floor: Recall@10 and MRR never silently erode", { skip: !existsSync(BENCH) || !existsSync(join(REPO, ".hunch", "hunch.sqlite")) }, async (t) => {
  const cases = JSON.parse(readFileSync(BENCH, "utf8")) as Array<{ query: string; expected: string[] }>;
  const store = new HunchStore(hunchPaths(REPO));
  t.after(() => store.close());

  let hits = 0;
  let mrr = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const refs = (await store.hybridSearch(c.query, 10)).map((h) => h.ref);
    const idx = refs.findIndex((r) => c.expected.includes(r));
    if (idx >= 0) {
      hits++;
      mrr += 1 / (idx + 1);
    } else {
      misses.push(c.query);
    }
  }
  mrr /= cases.length;

  assert.ok(
    hits >= RECALL_FLOOR,
    `Recall@10 fell below the floor: ${hits}/${cases.length} (floor ${RECALL_FLOOR}). Missing: ${misses.join(" | ")}`,
  );
  assert.ok(mrr >= MRR_FLOOR, `MRR fell below the floor: ${mrr.toFixed(3)} (floor ${MRR_FLOOR})`);
});
