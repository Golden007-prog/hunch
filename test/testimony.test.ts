/**
 * Memory supply chain — the authorship stamp. Only a consumed capture token
 * (proof of a grilling interview) mints human_confirmed; a unilateral agent
 * write lands as agent_recorded TESTIMONY: fully functional advisory memory
 * that never carries human authority, never locks the id slot against a later
 * human capture, and surfaces with a testimony marker in pre-edit grounding.
 * Exercised through the REAL MCP handler via an in-memory transport.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { renderGrounding } from "../src/core/topics.js";
import { isHumanConfirmed, isStrictBlocker } from "../src/core/strictgate.js";
import type { Decision } from "../src/core/types.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hunch-testimony-"));
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  const server = buildServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    root, client,
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ text: string }>).map((c) => c.text ?? "").join("\n");
    },
    cleanup: () => {
      void client.close().catch(() => {});
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp dir, OS reaps */ }
    },
  };
}

/** Read the durable JSON source of truth directly — no second store handle. */
const readDecisions = (root: string): Decision[] => {
  const dir = join(root, ".hunch", "decisions");
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Decision);
};

test("un-token'd record_decision lands as agent_recorded testimony, not human_confirmed", async () => {
  const t = await setup();
  try {
    const out = await t.call("hunch_record_decision", {
      decision: { title: "use the mirror registry", topic: "deps.registry", decision: "pull from mirror.internal" },
    });
    assert.ok(out.includes("agent_recorded"));
    assert.ok(out.includes("TESTIMONY"));
    const [d] = readDecisions(t.root);
    assert.equal(d!.provenance.source, "agent_recorded");
    assert.ok(d!.provenance.confidence < 0.8, "unvouched testimony must sit below the strict-confidence bar");
    assert.equal(isHumanConfirmed(d!.provenance.source), false);
    // and it could never strict-block even if someone marked it blocking-shaped
    assert.equal(isStrictBlocker({ severity: "blocking", provenance: d!.provenance }, false), false);
  } finally {
    t.cleanup();
  }
});

test("interview token mints human_confirmed; unverifiable token stays testimony with a countersign note", async () => {
  const t = await setup();
  try {
    const brief = await t.call("hunch_capture_decision", { topic: "auth.session" });
    const token = /capture_token:"([^"]+)"/.exec(brief)?.[1];
    assert.ok(token, "capture brief must issue a token");
    const ok1 = await t.call("hunch_record_decision", {
      decision: { title: "sessions are stateless JWTs", topic: "auth.session", decision: "JWT, 15m expiry" },
      capture_token: token,
    });
    assert.ok(ok1.includes("human_confirmed"));
    const confirmed = readDecisions(t.root).find((d) => d.topic === "auth.session")!;
    assert.equal(isHumanConfirmed(confirmed.provenance.source), true);
    assert.equal(confirmed.provenance.confidence, 0.95);

    const ok2 = await t.call("hunch_record_decision", {
      decision: { title: "another thing entirely", topic: "queue.backend", decision: "keep the queue" },
      capture_token: "cap_unknown_after_restart",
    });
    assert.ok(ok2.includes("agent_recorded"));
    assert.ok(ok2.includes("could not be verified"));
  } finally {
    t.cleanup();
  }
});

test("testimony never locks the slot: a later human capture takes over the same identity", async () => {
  const t = await setup();
  try {
    await t.call("hunch_record_decision", {
      decision: { title: "cache strategy", topic: "cache.strategy", decision: "agent's first guess" },
    });
    const brief = await t.call("hunch_capture_decision", { topic: "cache.strategy" });
    const token = /capture_token:"([^"]+)"/.exec(brief)?.[1]!;
    // same identity (same title+topic) re-recorded via the interview — must be
    // allowed (upgrade), not refused as overwriting a human record
    const out = await t.call("hunch_record_decision", {
      decision: { title: "cache strategy", topic: "cache.strategy", decision: "write-through, human-vetted" },
      capture_token: token,
    });
    assert.ok(out.includes("human_confirmed"), `human capture should upgrade testimony, got: ${out.slice(0, 200)}`);
    const live = readDecisions(t.root).filter((d) => d.topic === "cache.strategy" && d.status === "accepted" && !d.superseded_by);
    assert.equal(live.length, 1);
    assert.equal(isHumanConfirmed(live[0]!.provenance.source), true);
    assert.equal(live[0]!.decision, "write-through, human-vetted");
  } finally {
    t.cleanup();
  }
});

test("pre-edit grounding marks testimony, and only testimony", () => {
  const base = {
    status: "accepted", context: "", consequences: [], alternatives_rejected: [],
    rejected_tripwires: [], related_components: [], related_files: ["src/a.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
  const agent: Decision = { ...base, id: "dec_agent000001", title: "t1", topic: "top.a", decision: "agent said so", provenance: { source: "agent_recorded", confidence: 0.75, evidence: [] } } as Decision;
  const human: Decision = { ...base, id: "dec_human000001", title: "t2", topic: "top.b", decision: "human vouched", provenance: { source: "llm_draft+human_confirmed", confidence: 0.95, evidence: [] } } as Decision;
  const inferred: Decision = { ...base, id: "dec_infer000001", title: "t3", topic: "top.c", decision: "from the diff", provenance: { source: "inferred", confidence: 0.45, evidence: [] } } as Decision;
  const text = renderGrounding([agent, human, inferred], [agent, human, inferred]);
  const lines = text.split("\n");
  assert.ok(lines.find((l) => l.includes("top.a"))!.includes("agent-recorded testimony"));
  assert.ok(!lines.find((l) => l.includes("top.b"))!.includes("testimony"));
  assert.ok(!lines.find((l) => l.includes("top.c"))!.includes("testimony"), "diff-synthesized records keep their standing (implicit human vouch via the commit)");
});
