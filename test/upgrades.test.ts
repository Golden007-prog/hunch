import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff, summarizeDiff } from "../src/extractors/diff.js";
import { formatContext } from "../src/core/format.js";
import { tempStore, prov } from "./helpers.js";

test("analyzeDiff extracts added/removed/changed symbols and deps", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,4 @@",
    '+import Redis from "redis";',
    "-export function login(){}",
    "+export function verifySession(t){ return t; }",
    "+export function revokeSession(id){}",
    "-import old from \"legacy\";",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedSymbols.map((s) => s.name).sort(), ["revokeSession", "verifySession"]);
  assert.deepEqual(a.removedSymbols.map((s) => s.name), ["login"]);
  assert.deepEqual(a.addedDeps, ["redis"]);
  assert.deepEqual(a.removedDeps, ["legacy"]);
  const sum = summarizeDiff(a);
  assert.ok(sum.includes("verifySession") && sum.includes("redis"));
});

test("analyzeDiff detects a changed (both-sides) symbol as 'changed', and ignores non-code files", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "+# new heading",
    "diff --git a/src/x.ts b/src/x.ts",
    "-export function f(a){ return a; }",
    "+export function f(a, b){ return a + b; }",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.changedSymbols.map((s) => s.name), ["f"]);
  assert.equal(a.addedSymbols.length, 0);
  assert.equal(a.filesAdded.length, 0); // README.md not counted
});

test("staleness flags a record whose file changed after last_verified", () => {
  const { store, cleanup } = tempStore();
  store.json.put("constraints", { id: "con_1", type: "security", statement: "x", scope: ["src/auth.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: { source: "derived", confidence: 0.9, evidence: [], last_verified: "2026-01-01T00:00:00Z" } } as never);
  store.json.put("constraints", { id: "con_2", type: "security", statement: "y", scope: ["src/other.ts"], severity: "warning", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: { source: "derived", confidence: 0.9, evidence: [], last_verified: "2026-06-01T00:00:00Z" } } as never);
  // src/auth.ts changed 2026-03-01 (after con_1 verified, before con_2's later date / different file)
  const lastChange = (f: string) => (f === "src/auth.ts" ? "2026-03-01T00:00:00Z" : "");
  const stale = store.staleness(lastChange);
  assert.deepEqual(stale.map((s) => s.id), ["con_1"]);
  cleanup();
});

test("assembleContext orders invariants first, then decisions/bugs/blast radius", () => {
  const { store, cleanup } = tempStore();
  store.json.replaceAll("symbols", [
    { id: "sym_v", file: "src/auth.ts", name: "verify", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 1, bug_count: 0, fan_in: 1, fan_out: 0 }, last_changed: "" },
    { id: "sym_c", file: "src/bill.ts", name: "charge", kind: "function", signature_hash: "", calls: ["sym_v"], called_by: [], metrics: { loc: 5, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
  ] as never);
  store.json.replaceAll("edges", [{ id: "e1", from: "sym_c", to: "sym_v", type: "calls", reason: "", strength: 1, provenance: prov() }] as never);
  store.json.put("constraints", { id: "con_1", type: "security", statement: "server-side revocation", scope: ["src/auth.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: prov(0.9) } as never);
  store.json.put("decisions", { id: "dec_1", title: "Redis sessions", status: "accepted", context: "", decision: "server-side", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth.ts"], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.95), date: "2026-01-01T00:00:00Z" } as never);
  store.reindex();

  const ctx = store.assembleContext("src/auth.ts");
  assert.equal(ctx.constraints[0]?.id, "con_1");
  assert.equal(ctx.decisions[0]?.id, "dec_1");
  assert.ok(ctx.blast_radius.some((d) => d.via.includes("charge")), "blast radius includes the dependent");
  const text = formatContext(ctx);
  assert.ok(text.indexOf("Invariants") < text.indexOf("Decisions"), "invariants rendered before decisions");
  cleanup();
});

test("formatContext degrades gracefully and respects the budget", () => {
  const { store, cleanup } = tempStore();
  store.reindex();
  const text = formatContext(store.assembleContext("nope.ts", 1500));
  assert.ok(text.includes("still learning"), "graceful empty message");
  const tiny = formatContext({ target: "x", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], budget_tokens: 1 });
  assert.ok(tiny.length <= 60, "budget trims output");
  cleanup();
});
