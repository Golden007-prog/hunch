/**
 * Policy repair must heal the `via` selector too (round-2 audit #13).
 *
 * A must-pass-through assertion binds THREE selectors — subject, via, object — but
 * the repair planner only ever collected subject and object. After an ordinary file
 * rename the via binding kept pointing at the old symbol, so a proved active policy
 * either bricked (its semantic hash moved, invalidating the proof, while the stale
 * via could never be re-proved) or silently stopped enforcing. Repair runs
 * automatically from the post-commit hook, so neither outcome was visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPolicyRepair, repairPolicySpec } from "../src/constitution/repairPolicies.js";
import type { PolicySpec } from "../src/constitution/schema.js";

const NOW = "2026-08-06T00:00:00Z";

const mustPassThrough = (): PolicySpec => ({
  id: "pol_auth",
  revision: 1,
  state: "active_blocking",
  title: "every order path verifies the session",
  scope: { paths: ["src/api/orders.ts"] },
  assertion: {
    kind: "must-pass-through",
    subject: { selector: "symbol:src/api/orders.ts:listOrders" },
    relation: { kind: "reaches" },
    via: { selector: "symbol:src/auth/session.ts:verifySession" },
    object: { selector: "symbol:src/db/client.ts:dbQuery" },
  },
  audit: [],
  created_at: NOW,
  updated_at: NOW,
} as unknown as PolicySpec);

test("a rename of the VIA symbol's file is planned and applied (#13)", () => {
  const renames = [{ before: "src/auth/session.ts", after: "src/auth/sessions.ts" }];
  const plan = planPolicyRepair(renames, [mustPassThrough()]);
  assert.ok(
    plan.some((r) => r.from === "symbol:src/auth/session.ts:verifySession" && r.to === "symbol:src/auth/sessions.ts:verifySession"),
    `the via selector must be planned for rewrite; got ${JSON.stringify(plan)}`,
  );

  const repaired = repairPolicySpec(mustPassThrough(), plan, NOW);
  const assertion = repaired.assertion as { via: { selector: string }; subject: { selector: string }; object: { selector: string } };
  assert.equal(assertion.via.selector, "symbol:src/auth/sessions.ts:verifySession", "the via binding must be healed, not left dangling");
  // The other two bindings are untouched by this rename.
  assert.equal(assertion.subject.selector, "symbol:src/api/orders.ts:listOrders");
  assert.equal(assertion.object.selector, "symbol:src/db/client.ts:dbQuery");
  assert.equal(repaired.revision, 2, "a real rewrite bumps the revision");
  assert.ok(repaired.audit.some((a) => a.action === "repaired"), "and leaves a system-actor audit entry");
});

test("subject and object of a must-pass-through still heal, and all three can heal at once (#13)", () => {
  const renames = [
    { before: "src/api/orders.ts", after: "src/api/order-routes.ts" },
    { before: "src/auth/session.ts", after: "src/auth/sessions.ts" },
    { before: "src/db/client.ts", after: "src/db/pool.ts" },
  ];
  const plan = planPolicyRepair(renames, [mustPassThrough()]);
  const repaired = repairPolicySpec(mustPassThrough(), plan, NOW);
  const a = repaired.assertion as { via: { selector: string }; subject: { selector: string }; object: { selector: string } };
  assert.equal(a.subject.selector, "symbol:src/api/order-routes.ts:listOrders");
  assert.equal(a.via.selector, "symbol:src/auth/sessions.ts:verifySession");
  assert.equal(a.object.selector, "symbol:src/db/pool.ts:dbQuery");
  assert.deepEqual(repaired.scope.paths, ["src/api/order-routes.ts"], "the exact scope path heals too");
});

test("an unrelated rename leaves a must-pass-through policy untouched", () => {
  const plan = planPolicyRepair([{ before: "src/unrelated.ts", after: "src/other.ts" }], [mustPassThrough()]);
  assert.deepEqual(plan, []);
  const original = mustPassThrough();
  assert.equal(repairPolicySpec(original, plan, NOW), original, "no rewrites ⇒ the same reference back");
});
