// Issue #474: every delivered brief line ends in `hunch_why("<record id>")`, so
// why() must resolve a record id — and say so plainly when the id is unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { tempStore } from "./helpers.js";
import type { Decision, Constraint } from "../src/core/types.js";

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
