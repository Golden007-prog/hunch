import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { blockingInScope } from "../src/core/hookpolicy.js";
import { prov } from "./helpers.js";

// jwt.ts ← session.ts ← charge.ts : a 2-hop dependency chain (mirrors check.test).
function indexed() {
  const root = mkdtempSync(join(tmpdir(), "hunch-hookpolicy-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  const syms = store.json.loadAll("symbols");
  const fileOf = (name: string) => syms.find((s) => s.name === name)!.file;
  return { store, root, fileOf, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function seedBlocking(store: HunchStore, scopeFile: string) {
  store.json.put("constraints", {
    id: "con_billing", statement: "billing rounds half-up", scope: [scopeFile],
    severity: "blocking", rationale: "money", provenance: prov(),
  } as never);
  store.reindex();
}

test("blockingInScope flags a DIRECT hit on the invariant's scope", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge");
    seedBlocking(store, charge);
    const hit = blockingInScope(store, charge);
    assert.ok(hit, "direct edit of a blocking-invariant file is flagged");
    assert.match(hit!.reason, /billing rounds half-up/);
    assert.match(hit!.reason, /con_billing/);
  } finally { cleanup(); }
});

test("blockingInScope flags a NEAR hit reached via blast radius", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge"), jwt = fileOf("jwtDecode");
    seedBlocking(store, charge);
    // Editing jwt.ts only INDIRECTLY reaches the billing invariant (jwt ← session ← charge).
    assert.equal(store.checkConstraints(jwt).length, 0, "no direct hit on jwt");
    const hit = blockingInScope(store, jwt);
    assert.ok(hit, "blast-radius hit is flagged");
    assert.match(hit!.reason, /blast radius/);
  } finally { cleanup(); }
});

test("blockingInScope returns null when the invariant is neither in scope nor downstream", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    // Constraint on the leaf jwt.ts. Editing charge.ts (the top of the chain) can't
    // affect jwt.ts — blast radius is DEPENDENTS, and nothing imports charge.ts.
    seedBlocking(store, fileOf("jwtDecode"));
    assert.equal(blockingInScope(store, fileOf("charge")), null);
  } finally { cleanup(); }
});

test("deny reason never coaches lowering enforcement (no bypass instructions)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge");
    seedBlocking(store, charge);
    const direct = blockingInScope(store, charge)!.reason;
    const near = blockingInScope(store, fileOf("jwtDecode"))!.reason;
    for (const reason of [direct, near]) {
      assert.doesNotMatch(reason, /firmness/i, "must not mention the firmness command");
      assert.doesNotMatch(reason, /lower|disable|bypass|--no-/i, "must not tell the agent how to get around the guard");
    }
  } finally { cleanup(); }
});
