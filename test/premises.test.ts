/**
 * Premise decay (world≠graph) — the checkable reasons a decision rests on.
 * Covers: schema back-compat (no premises = legacy behavior, no migration),
 * at-most-one-check refinement, deterministic evaluation (path_absent /
 * path_exists / review_by attestations / claim-only), the fail-open lesson
 * (cannot-evaluate NEVER reads as holds), escalation shaping (one per live
 * decision, question-framed, authority explicitly unchanged, rejected
 * alternatives mentioned by count only), superseded decisions staying silent,
 * and the premise-stale drift kind on a real store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import { DecisionSchema, type Decision } from "../src/core/types.js";
import { evaluatePremises, premiseEscalations, type PremiseEnv } from "../src/core/premises.js";
import { computeDrift } from "../src/core/drift.js";

const NOW = "2026-08-09T12:00:00.000Z";
const env = (existing: string[] = []): PremiseEnv => ({ now: NOW, exists: (p) => existing.includes(p) });

const dec = (over: Partial<Decision> = {}): Decision =>
  DecisionSchema.parse({
    id: "dec_premise001",
    title: "routes go through the service layer",
    status: "accepted",
    provenance: prov(),
    date: "2026-01-01",
    ...over,
  });

test("schema: decisions without premises parse unchanged (back-compat, no migration)", () => {
  const d = dec();
  assert.equal(d.premises, undefined);
  assert.deepEqual(evaluatePremises(d, env()), []);
});

test("schema: a premise carries at most one check", () => {
  assert.throws(() =>
    DecisionSchema.parse({
      id: "dec_x", title: "t", provenance: prov(), date: "2026-01-01",
      premises: [{ claim: "c", path_absent: "a", review_by: "2027-01-01" }],
    }),
  );
});

test("path_absent: holds while absent, dies when the path appears", () => {
  const d = dec({ premises: [{ claim: "no gateway auth layer yet", path_absent: "src/gateway" }] });
  assert.equal(evaluatePremises(d, env())[0]!.holds, true);
  const [v] = evaluatePremises(d, env(["src/gateway"]));
  assert.equal(v!.holds, false);
  assert.ok(v!.reason.includes("now exists"));
});

test("path_exists: dies when the path disappears", () => {
  const d = dec({ premises: [{ claim: "the legacy queue is still deployed", path_exists: "src/queue.ts" }] });
  assert.equal(evaluatePremises(d, env(["src/queue.ts"]))[0]!.holds, true);
  assert.equal(evaluatePremises(d, env())[0]!.holds, false);
});

test("review_by: attestation holds until due, then needs a human", () => {
  const fresh = dec({ premises: [{ claim: "no ops team", review_by: "2027-01-01T00:00:00Z", attested: "2026-08-01" }] });
  assert.equal(evaluatePremises(fresh, env())[0]!.holds, true);
  const overdue = dec({ premises: [{ claim: "no ops team", review_by: "2026-07-01T00:00:00Z", attested: "2025-07-01" }] });
  const [v] = evaluatePremises(overdue, env());
  assert.equal(v!.holds, false);
  assert.ok(v!.reason.includes("expired 2026-07-01"));
  assert.ok(v!.reason.includes("last attested 2025-07-01"));
});

test("cannot-evaluate NEVER reads as holds (fail-open lesson): bad paths and bad dates fail loudly", () => {
  const escape = dec({ premises: [{ claim: "c", path_absent: "../outside" }] });
  const abs = dec({ premises: [{ claim: "c", path_exists: "/etc/passwd" }] });
  const badDate = dec({ premises: [{ claim: "c", review_by: "soonish" }] });
  for (const d of [escape, abs, badDate]) {
    const [v] = evaluatePremises(d, env(["../outside", "/etc/passwd"]));
    assert.equal(v!.holds, false);
    assert.ok(v!.reason.includes("unevaluable"));
  }
});

test("claim-only premises document but can never fire", () => {
  const d = dec({ premises: [{ claim: "consistency with the mobile team's stack" }] });
  const [v] = evaluatePremises(d, env());
  assert.equal(v!.holds, true);
  assert.deepEqual(premiseEscalations([d], env()), []);
});

test("escalations: one question-framed entry per live decision; authority explicitly unchanged; rejections counted, not relitigated", () => {
  const d = dec({
    topic: "orders.data-access",
    alternatives_rejected: ["direct DB access with gateway-level auth", "GraphQL federation"],
    premises: [
      { claim: "no gateway auth layer yet", path_absent: "src/gateway" },
      { claim: "no ops team", review_by: "2026-07-01T00:00:00Z" },
    ],
  });
  const items = premiseEscalations([d], env(["src/gateway"]));
  assert.equal(items.length, 1);
  const e = items[0]!;
  assert.equal(e.kind, "premise-stale");
  assert.equal(e.topic, "orders.data-access");
  assert.deepEqual(e.decisionIds, [d.id]);
  assert.ok(e.question.includes("2 premise(s)"));
  assert.ok(e.question.endsWith("?"), "an entry is a question, never an approval");
  assert.ok(e.detail.includes("2 rejected alternative(s)"));
  assert.ok(!e.detail.includes("GraphQL"), "rejected alternatives are counted, never spelled back into context");
  assert.ok(e.resolution.includes("UNCHANGED"));
});

test("escalations: superseded and healthy decisions stay silent", () => {
  const superseded = dec({ id: "dec_premise002", status: "superseded", premises: [{ claim: "c", path_absent: "src/gateway" }] });
  const healthy = dec({ id: "dec_premise003", premises: [{ claim: "c", path_absent: "src/gateway" }] });
  assert.deepEqual(premiseEscalations([superseded, healthy], env()), []);
});

test("drift: a dead premise on a live decision fires premise-stale; a superseded one does not", () => {
  const t = tempStore();
  try {
    mkdirSync(join(t.root, "src", "gateway"), { recursive: true });
    writeFileSync(join(t.root, "src", "gateway", "auth.ts"), "export const auth = 1;\n");
    t.store.json.put("decisions", dec({
      related_files: [],
      premises: [{ claim: "no gateway auth layer yet", path_absent: "src/gateway" }],
    }));
    t.store.json.put("decisions", dec({
      id: "dec_premise004",
      status: "superseded",
      premises: [{ claim: "c", path_absent: "src/gateway" }],
    }));
    const hits = computeDrift(t.store, t.root).findings.filter((f) => f.kind === "premise-stale");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.id, "dec_premise001");
    assert.ok(hits[0]!.detail.includes("no gateway auth layer yet"));
    assert.ok(hits[0]!.detail.includes("authority unchanged"));
  } finally {
    t.cleanup();
  }
});

/** Regressions from the adversarial review of the premise-decay commit. */

test("an unparseable clock is unevaluable, never 'holds' (#2)", () => {
  // Date.parse("nope") is NaN and `NaN > due` is false, which fell through to
  // "attested until …" — i.e. HOLDS. The module's hard rule was enforced for a bad
  // review_by but not for a bad now, and PremiseEnv.now is a public input.
  const d = {
    id: "dec_clock", title: "t", status: "accepted", superseded_by: null, valid_to: null,
    alternatives_rejected: [], topic: null,
    premises: [{ claim: "reviewed recently", review_by: "2099-01-01" }],
  } as never;
  const verdicts = evaluatePremises(d, { now: "nope", exists: () => false });
  assert.equal(verdicts[0]!.holds, false, "a bad clock must not vouch for the premise");
  assert.match(verdicts[0]!.reason, /unevaluable/);
});

test("a bad clock is unevaluable for EVERY check kind, not just the dated one (#2)", () => {
  const mk = (p: Record<string, unknown>) => ({
    id: "dec_x", title: "t", status: "accepted", superseded_by: null, valid_to: null,
    alternatives_rejected: [], topic: null, premises: [p],
  }) as never;
  for (const p of [
    { claim: "a", path_absent: "src/gateway" },
    { claim: "b", path_exists: "src/core" },
    { claim: "c", review_by: "2099-01-01" },
  ]) {
    const [v] = evaluatePremises(mk(p), { now: "", exists: () => true });
    assert.equal(v!.holds, false, `check ${JSON.stringify(p)} must be unevaluable under a bad clock`);
  }
});

test("a good clock still evaluates normally (no regression) (#2)", () => {
  const d = {
    id: "dec_ok", title: "t", status: "accepted", superseded_by: null, valid_to: null,
    alternatives_rejected: [], topic: null,
    premises: [{ claim: "reviewed recently", review_by: "2099-01-01" }],
  } as never;
  const [v] = evaluatePremises(d, { now: "2026-08-09T00:00:00Z", exists: () => false });
  assert.equal(v!.holds, true, "a valid future attestation still holds");
});
