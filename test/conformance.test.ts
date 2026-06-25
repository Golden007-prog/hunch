import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { checkConformance } from "../src/core/conformance.js";
import type { Decision } from "../src/core/types.js";

const PROV = () => ({ source: "human_confirmed" as const, confidence: 1, evidence: [] });
const DEC = (id: string, conformance: unknown[]) =>
  ({
    id, title: id, status: "accepted", context: "", decision: "",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: [], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    retired: { symbols: [], deps: [] }, conformance, provenance: PROV(), date: "2026-01-01T00:00:00Z",
  }) as unknown as Decision;

function indexedRepo(chargeBody: string) {
  const root = mkdtempSync(join(tmpdir(), "hunch-conf-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/jwt.ts"), "export function jwtDecode(t){ return t; }\n");
  writeFileSync(join(root, "src/auth/session.ts"), 'import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n');
  writeFileSync(join(root, "src/billing/charge.ts"), chargeBody);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("conformance proves code SATISFIES intent and catches direct-vs-transitive + existence", () => {
  const { store, cleanup } = indexedRepo('import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n');
  try {
    store.json.put("decisions", DEC("dec_verify", [{ assert: "calls", subject: "charge", object: "verifySession", transitive: false }]));
    store.json.put("decisions", DEC("dec_jwt_t", [{ assert: "calls", subject: "charge", object: "jwtDecode", transitive: true }]));
    store.json.put("decisions", DEC("dec_jwt_d", [{ assert: "calls", subject: "charge", object: "jwtDecode", transitive: false }]));
    store.json.put("decisions", DEC("dec_notcall", [{ assert: "not-calls", subject: "jwtDecode", object: "charge", transitive: true }]));
    store.json.put("decisions", DEC("dec_exist", [{ assert: "exists", subject: "verifySession" }]));
    store.json.put("decisions", DEC("dec_gone", [{ assert: "exists", subject: "ghostFn" }]));
    store.reindex();

    const r = checkConformance(store);
    const sat = (id: string) => r.find((x) => x.decision === id)!.satisfied;
    assert.equal(sat("dec_verify"), true, "charge directly calls verifySession");
    assert.equal(sat("dec_jwt_t"), true, "charge transitively reaches jwtDecode");
    assert.equal(sat("dec_jwt_d"), false, "charge does NOT directly call jwtDecode");
    assert.equal(sat("dec_notcall"), true, "jwtDecode never reaches charge");
    assert.equal(sat("dec_exist"), true, "verifySession exists");
    assert.equal(sat("dec_gone"), false, "ghostFn is gone → intent violated");
  } finally { cleanup(); }
});

test("conformance catches DRIFT: code that stopped honoring the intent flips to violated", () => {
  // charge no longer calls verifySession — the recorded intent is now false of the code.
  const { store, cleanup } = indexedRepo("export function charge(t){ return t; }\n");
  try {
    store.json.put("decisions", DEC("dec_verify", [{ assert: "calls", subject: "charge", object: "verifySession", transitive: true }]));
    store.reindex();
    const r = checkConformance(store);
    assert.equal(r[0]!.satisfied, false, "code drifted: charge no longer reaches verifySession");
    assert.match(r[0]!.detail, /VIOLATED/);
  } finally { cleanup(); }
});
