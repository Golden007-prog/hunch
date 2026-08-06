/**
 * The no-FTS5 fallback must find identifiers (round-3 audit #11).
 *
 * `_` is BOTH a LIKE single-character wildcard and the dominant character in this
 * codebase's identifiers — record ids (dec_, con_, bug_, fnd_) and snake_case symbols.
 * likeSearch STRIPPED `_` out of its patterns, so `hunch_record_decision` was searched
 * for as the literal `hunchrecorddecision` and matched nothing.
 *
 * That lands on exactly the runtimes where this fallback is the ONLY search there is —
 * a SQLite build without the optional FTS5 module. And because the query then truncated
 * at LIMIT in rowid order, a constraint a caller was checking for could be dropped even
 * when it did match.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { openMemoryDb } from "../src/store/db.js";
import type { DB } from "../src/store/db.js";

/** A store whose search table is the plain (no-FTS5) schema, as openDb selects when
 *  sqlite_compileoption_used reports no ENABLE_FTS5. */
function plainStore(): ReturnType<typeof tempStore> {
  const s = tempStore();
  (s.store as unknown as { _db: DB | null })._db = openMemoryDb({ forcePlainSearch: true });
  return s;
}

const DEC = (id: string, title: string, decision: string) => ({
  id, title, status: "accepted", context: "", decision,
  consequences: [], alternatives_rejected: [], related_components: [], related_files: [],
  supersedes: null, caused_by_bug: null, commit: null,
  provenance: prov(0.9), date: "2026-08-06T00:00:00Z",
});

test("an underscored identifier is found, not silently stripped to nothing (#11)", (t) => {
  const { store, cleanup } = plainStore();
  t.after(cleanup);
  store.json.put("decisions", DEC("dec_ident", "Route captures through hunch_record_decision", "All writes go through hunch_record_decision.") as never);
  store.reindex();

  const refs = store.search("hunch_record_decision").map((h) => h.ref);
  assert.ok(refs.includes("dec_ident"), `identifier query must match, got ${JSON.stringify(refs)}`);
});

test("the underscore is escaped, not left as a wildcard — no over-matching (#11)", (t) => {
  const { store, cleanup } = plainStore();
  t.after(cleanup);
  // If `_` were passed through unescaped it is a single-char wildcard, so `put_x`
  // would also match `putax`. Escaping keeps the term literal in BOTH directions.
  store.json.put("decisions", DEC("dec_literal", "put_x helper", "the put_x helper") as never);
  store.json.put("decisions", DEC("dec_decoy", "putax helper", "the putax helper") as never);
  store.reindex();

  const refs = store.search("put_x").map((h) => h.ref);
  assert.ok(refs.includes("dec_literal"), "the literal identifier matches");
  assert.ok(!refs.includes("dec_decoy"), "`_` must not act as a wildcard and drag in putax");
});

test("a record id CITED IN PROSE is findable (#11)", (t) => {
  const { store, cleanup } = plainStore();
  t.after(cleanup);
  // The id is the `ref` column, not indexed text (see the fts() calls in reindex), so a
  // bare-id lookup was never on offer. What the underscore-strip DID break is the common
  // case of one record citing another by id in its body — "supersedes dec_abc123".
  store.json.put("decisions", DEC("dec_citing", "Cursor pagination", "Supersedes dec_abc123 which used offsets.") as never);
  store.reindex();
  assert.ok(
    store.search("dec_abc123").map((h) => h.ref).includes("dec_citing"),
    "an id cited in prose carries underscores and must still match",
  );
});

test("a truncating limit drops the least relevant row, not an arbitrary one (#11)", (t) => {
  const { store, cleanup } = plainStore();
  t.after(cleanup);
  // Many records merely MENTION the term in their body; one carries it in the title.
  for (let i = 0; i < 12; i++) {
    store.json.put("decisions", DEC(`dec_body${i}`, `Unrelated subject ${i}`, "incidental mention of tenant_scope in prose") as never);
  }
  store.json.put("constraints", {
    id: "con_target", type: "correctness", statement: "tenant_scope must be applied to every query",
    scope: ["**"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null,
    rationale: "", source_decision: null, violations: [], status: "active",
    valid_from: "2026-08-06T00:00:00Z", valid_to: null, provenance: prov(1),
  } as never);
  store.reindex();

  const refs = store.search("tenant_scope", 3).map((h) => h.ref);
  assert.ok(refs.includes("con_target"), `the title match must survive truncation, got ${JSON.stringify(refs)}`);
});

test("ordinary prose search still works (no regression) (#11)", (t) => {
  const { store, cleanup } = plainStore();
  t.after(cleanup);
  store.json.put("decisions", DEC("dec_plain", "Redis session memory", "Keep sessions server-side") as never);
  store.reindex();
  assert.ok(store.search("redis sessions").some((h) => h.ref === "dec_plain"));
});
