import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { adjudicateCausalInterventions, applyCausalIntervention, enumerateCausalInterventions } from "../bench/external/causal-intervention.js";

test("causal interventions stay inside the selected owner and prefer observed lines", () => {
  const content = [
    "export function unrelated(value: number) { return value > 10; }",
    "export function decide(value: number, enabled: boolean) {",
    "  if (enabled && value >= 3) return true;",
    "  return value === 0 ? false : !enabled;",
    "}",
  ].join("\n");
  const mutations = enumerateCausalInterventions("src/example.ts", content, "src/example.ts::decide", [3], 20);
  assert.ok(mutations.length >= 6);
  assert.equal(mutations[0]!.line, 3);
  assert.ok(mutations.every((mutation) => mutation.line >= 2));
  assert.ok(mutations.every((mutation) => !mutation.before.includes("10")));
  for (const mutation of mutations) {
    const next = applyCausalIntervention(content, mutation);
    assert.notEqual(next, content);
    const parsed = ts.createSourceFile("src/example.ts", next, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.equal(parsed.parseDiagnostics.length, 0, mutation.id);
  }
});

test("causal interventions fail closed when the source span changes", () => {
  const content = "export const decide = (value: boolean) => value === true;\n";
  const [mutation] = enumerateCausalInterventions("src/example.ts", content, "src/example.ts::decide");
  assert.ok(mutation);
  assert.throws(() => applyCausalIntervention(`// shifted\n${content}`, mutation!), /no longer matches/);
});

test("causal adjudication ignores infrastructure levers and requires one behavioral owner", () => {
  assert.deepEqual(adjudicateCausalInterventions([
    { owner: "src/util.ts::defineLazy", admitted: true },
    { owner: "src/serializer.ts::objectProcessor", admitted: true },
  ]), {
    owner: "src/serializer.ts::objectProcessor",
    reason: "unique-behavioral-owner",
    admitted_owners: ["src/serializer.ts::objectProcessor"],
    infrastructure_levers: ["src/util.ts::defineLazy"],
  });
  assert.equal(adjudicateCausalInterventions([
    { owner: "src/regexes.ts::datetime", admitted: true },
    { owner: "src/api.ts::_isoDateTime", admitted: true },
  ]).reason, "ambiguous-behavioral-owners");
  assert.equal(adjudicateCausalInterventions([
    { owner: "src/core.ts::config", admitted: true },
  ]).reason, "no-behavioral-owner");
});
