// Issue #474: every delivered brief line ends in `hunch_why("<record id>")`, so
// why() must resolve a record id — and say so plainly when the id is unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { tempStore } from "./helpers.js";
import type { Decision, Constraint } from "../src/core/types.js";
import { formatWhyRecord } from "../src/core/whyRecord.js";

function mkDecision(over: Partial<Decision> & { id: string }): Decision {
  return {
    title: "t", topic: null, status: "accepted", context: "", decision: "d", consequences: [],
    alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: ["src/auth/session.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    date: "2026-01-01T00:00:00Z",
    ...over,
  } as Decision;
}

function mkConstraint(over: Partial<Constraint> & { id: string }): Constraint {
  return {
    type: "correctness", statement: "x", scope: ["src/auth/**"], severity: "warning",
    enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [],
    status: "active", valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    ...over,
  } as Constraint;
}

function seed(store: ReturnType<typeof tempStore>["store"]): void {
  store.json.put("decisions", mkDecision({
    id: "dec_0a0a0a0a01", title: "Cookie sessions", status: "superseded", superseded_by: "dec_0b5d2be516",
    valid_to: "2026-03-01T00:00:00Z",
  }));
  store.json.put("decisions", mkDecision({
    id: "dec_0b5d2be516", title: "Redis-backed sessions", topic: "auth.sessions", supersedes: "dec_0a0a0a0a01",
    decision: "Store sessions in Redis.", alternatives_rejected: ["JWT-only sessions (no revocation)"],
    consequences: ["Redis is a hard dependency"],
  }));
  store.json.put("constraints", mkConstraint({
    id: "con_1234abcd56", statement: "Session tokens must never be logged", severity: "blocking", rationale: "PII",
  }));
}

async function callWhy(root: string, target: string): Promise<string> {
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "why-by-id-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await client.callTool({ name: "hunch_why", arguments: { target } });
    return (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

test("why(<decision id>) returns the decision with rejected alternatives and its supersession chain", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    seed(store);
    const w = store.why("dec_0b5d2be516");
    assert.equal(w.byId?.record?.kind, "decision");
    assert.equal(w.byId?.record?.kind === "decision" && w.byId.record.chain.map((c) => c.id).join(">"), "dec_0a0a0a0a01>dec_0b5d2be516");
    const text = await callWhy(root, "dec_0b5d2be516");
    assert.match(text, /Redis-backed sessions/);
    assert.match(text, /JWT-only sessions \(no revocation\)/);
    assert.match(text, /topic: auth\.sessions/);
    assert.match(text, /supersedes: dec_0a0a0a0a01/);
  } finally {
    cleanup();
  }
});

test("why(<constraint id>) returns the constraint statement", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    seed(store);
    assert.equal(store.why("con_1234abcd56").byId?.record?.kind, "constraint");
    const text = await callWhy(root, "con_1234abcd56");
    assert.match(text, /Session tokens must never be logged/);
    assert.match(text, /blocking/);
  } finally {
    cleanup();
  }
});

test("why(<unknown well-formed id>) says no record, not silently empty", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    seed(store);
    const w = store.why("dec_ffffffffff");
    assert.equal(w.byId?.id, "dec_ffffffffff");
    assert.equal(w.byId?.record, null);
    const text = await callWhy(root, "dec_ffffffffff");
    assert.match(text, /No record dec_ffffffffff/);
  } finally {
    cleanup();
  }
});

test("a file path still resolves by path, with no by-id result", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    seed(store);
    const w = store.why("src/auth/session.ts");
    assert.equal(w.byId, undefined);
    assert.deepEqual(w.decisions.map((d) => d.id).sort(), ["dec_0a0a0a0a01", "dec_0b5d2be516"]);
    assert.deepEqual(w.constraints.map((c) => c.id), ["con_1234abcd56"]);
    const text = await callWhy(root, "src/auth/session.ts");
    assert.match(text, /DECISIONS:/);
    assert.match(text, /CONSTRAINTS \(must not break\):/);
    assert.doesNotMatch(text, /No record/);
  } finally {
    cleanup();
  }
});

test("why(<id>, {asOf}) gates existence and neighbours, and prints the same stored status as the path view", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_1", title: "Old", status: "superseded", superseded_by: "dec_2",
      valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-06-01T00:00:00Z",
    }));
    store.json.put("decisions", mkDecision({
      id: "dec_2", title: "New", supersedes: "dec_1",
      valid_from: "2026-06-01T00:00:00Z", date: "2026-06-01T00:00:00Z",
    }));
    const asOf = "2026-03-01T00:00:00Z";
    const old = store.why("dec_1", { asOf }).byId?.record;
    assert.equal(old?.kind, "decision");
    if (old?.kind !== "decision") return;
    const viaPath = store.why("src/auth/session.ts", { asOf }).decisions.find((d) => d.id === "dec_1");
    assert.equal(old.record.status, "superseded", "stored status, not rewritten");
    assert.equal(old.record.status, viaPath?.status, "id and path views agree on status at asOf");
    assert.equal(old.record.superseded_by, null, "successor had not started");
    assert.deepEqual(old.chain.map((c) => c.id), ["dec_1"]);
    assert.doesNotMatch(formatWhyRecord({ id: "dec_1", record: old }).join("\n"), /dec_2/);

    const fresh = store.why("dec_2", { asOf });
    assert.equal(fresh.byId?.record, null, "dec_2 did not exist at asOf");
    assert.match(formatWhyRecord(fresh.byId!).join("\n"), /No record dec_2 as of 2026-03-01/);

    // Without asOf: full history, unchanged.
    const now = store.why("dec_1").byId?.record;
    assert.equal(now?.kind === "decision" && now.record.status, "superseded");
  } finally {
    cleanup();
  }
});

test("by-id output is bounded: lists capped with a 'more' note, long prose clipped", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_0c0c0c0c0c", title: "Big", decision: "x".repeat(5000),
      alternatives_rejected: Array.from({ length: 20 }, (_, i) => `alt-${i} ${"y".repeat(1000)}`),
      related_files: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
    }));
    const text = formatWhyRecord(store.why("dec_0c0c0c0c0c").byId!).join("\n");
    assert.match(text, /alt-5 /);
    assert.doesNotMatch(text, /alt-6 /, "alternatives capped at WHY_CAP");
    assert.match(text, /\+14 more/);
    assert.doesNotMatch(text, /src\/f6\.ts/);
    assert.match(text, /\+24 more/);
    assert.ok(text.length < 4000, `bounded output (${text.length} chars)`);
  } finally {
    cleanup();
  }
});

test("a supersedes/superseded_by neighbour the caller cannot read is not printed", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const canRead = (r: unknown) => (r as { id: string }).id !== "dec_0a0a0a0a01";
    const w = store.why("dec_0b5d2be516", { canRead });
    const text = formatWhyRecord(w.byId!).join("\n");
    assert.match(text, /Redis-backed sessions/);
    assert.doesNotMatch(text, /dec_0a0a0a0a01/);
  } finally {
    cleanup();
  }
});

test("as_of keeps a LEGACY superseded decision / retired constraint as recorded (no successor or valid_to on file)", () => {
  const { store, cleanup } = tempStore();
  try {
    // The v2 migration leaves these windows open on purpose (dec_777f0b8d14).
    store.json.put("decisions", mkDecision({ id: "dec_aa", title: "Legacy", status: "superseded", superseded_by: null, valid_to: null }));
    store.json.put("constraints", mkConstraint({ id: "con_bb", statement: "Legacy rule", severity: "blocking", status: "retired", valid_to: null }));
    const asOf = "2026-03-01T00:00:00Z";
    const d = store.why("dec_aa", { asOf }).byId?.record;
    assert.equal(d?.kind === "decision" && d.record.status, "superseded");
    const c = store.why("con_bb", { asOf }).byId?.record;
    assert.equal(c?.kind === "constraint" && c.record.status, "retired");
    assert.match(formatWhyRecord({ id: "con_bb", record: c! }).join("\n"), /blocking\/retired/);
  } finally {
    cleanup();
  }
});

test("as_of gates a constraint by its window but keeps its stored status", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("constraints", mkConstraint({ id: "con_cc", statement: "Old rule", status: "retired", valid_to: "2026-06-01T00:00:00Z" }));
    const c = store.why("con_cc", { asOf: "2026-03-01T00:00:00Z" }).byId?.record;
    assert.equal(c?.kind === "constraint" && c.record.status, "retired");
    assert.equal(store.why("con_cc", { asOf: "2026-07-01T00:00:00Z" }).byId?.record, null, "retired by then");
  } finally {
    cleanup();
  }
});

test("clipping never splits a surrogate pair", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_0d0d0d0d0d", title: "Emoji", decision: "😀".repeat(2000) }));
    const text = formatWhyRecord(store.why("dec_0d0d0d0d0d").byId!).join("\n");
    assert.doesNotThrow(() => encodeURIComponent(text), "well-formed UTF-16 (a lone surrogate throws URIError)");
    assert.match(text, /…/);
  } finally {
    cleanup();
  }
});
