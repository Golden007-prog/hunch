import { test } from "node:test";
import assert from "node:assert/strict";
import { exportMadrCorpus, renderMadr, isRegenerableMadr, MADR_EXPORT_MARKER } from "../src/integrations/madrExport.js";
import { parseAdrMarkdown } from "../src/extractors/adrImport.js";
import type { Decision } from "../src/core/types.js";

function dec(partial: Partial<Decision> & { id: string; title: string }): Decision {
  return {
    topic: null,
    status: "accepted",
    context: "",
    decision: "",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    date: "2024-01-01T00:00:00.000Z",
    ...partial,
  } as Decision;
}

const OLD = dec({
  id: "dec_old111111",
  title: "Store sessions in Redis",
  status: "superseded",
  superseded_by: "dec_new222222",
  valid_from: "2024-01-01T00:00:00.000Z",
  valid_to: "2024-06-01T00:00:00.000Z",
  decision: "Sessions in Redis with TTL.",
});
const NEW = dec({
  id: "dec_new222222",
  title: "Store sessions in Postgres",
  supersedes: "dec_old111111",
  valid_from: "2024-06-01T00:00:00.000Z",
  context: "Redis was the only non-relational stateful service.",
  decision: "Move sessions into Postgres.",
  consequences: ["One fewer service to operate."],
  alternatives_rejected: ["Keep Redis", "JWT-only stateless sessions"],
});

test("exportMadrCorpus numbers by date order and links supersede pairs both ways", () => {
  const { files } = exportMadrCorpus([NEW, OLD], "docs/adr");
  assert.deepEqual(files.map((f) => f.name), ["0001-store-sessions-in-redis.md", "0002-store-sessions-in-postgres.md"]);
  const [redis, pg] = files.map((f) => f.text);
  assert.match(redis!, /status: superseded by \[0002-store-sessions-in-postgres\.md\]/);
  assert.match(pg!, /Supersedes \[0001-store-sessions-in-redis\.md\]/);
  assert.match(pg!, /- Store sessions in Postgres\n- Keep Redis/);
  assert.match(pg!, /Chosen option: "Store sessions in Postgres"/);
  assert.match(pg!, /### Consequences\n\n- One fewer service to operate\./);
});

test("every rendered file carries the generated marker and its source decision id", () => {
  const text = renderMadr(NEW, new Map());
  assert.ok(text.includes(MADR_EXPORT_MARKER));
  assert.ok(text.includes("<!-- source: dec_new222222 -->"));
  assert.ok(isRegenerableMadr(text));
  assert.equal(isRegenerableMadr("# A hand-written ADR\n\n## Status\nAccepted\n"), false);
});

test("the projection round-trips through the importer without losing the contract", () => {
  const { files } = exportMadrCorpus([NEW, OLD], "docs/adr");
  const redis = parseAdrMarkdown(files[0]!.text, `docs/adr/${files[0]!.name}`)!;
  const pg = parseAdrMarkdown(files[1]!.text, `docs/adr/${files[1]!.name}`)!;
  assert.equal(redis.status, "superseded");
  assert.deepEqual(redis.supersededByNumbers, [2]);
  assert.equal(pg.status, "accepted");
  assert.equal(pg.chosenOption?.toLowerCase().includes("postgres"), true);
  assert.ok(pg.consideredOptions.some((o) => o.includes("Keep Redis")));
  assert.match(pg.context, /non-relational stateful service/);
});

test("an undated-but-closed decision numbers by its window close, never after its successor", () => {
  const undatedOld = dec({
    id: "dec_old111111",
    title: "Store sessions in Redis",
    status: "superseded",
    superseded_by: "dec_new222222",
    valid_to: "2024-06-01T00:00:00.000Z",
    date: "2026-01-01T00:00:00.000Z",
  });
  const { files } = exportMadrCorpus([NEW, undatedOld], "docs/adr");
  assert.deepEqual(files.map((f) => f.name.slice(0, 4)), ["0001", "0002"]);
  assert.ok(files[0]!.text.includes("Store sessions in Redis"), "superseded ADR numbers first despite its late record date");
});

test("duplicate titles get disambiguated file names", () => {
  const a = dec({ id: "dec_aaaaaaaaaa", title: "Use PostgreSQL", valid_from: "2024-01-01" });
  const b = dec({ id: "dec_bbbbbbbbbb", title: "Use PostgreSQL", valid_from: "2024-02-01" });
  const { files } = exportMadrCorpus([a, b], "docs/adr");
  assert.equal(new Set(files.map((f) => f.name)).size, 2, "no filename collision");
});
