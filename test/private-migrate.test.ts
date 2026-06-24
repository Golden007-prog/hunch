import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import { movePublicMemoryToPrivate } from "../src/store/privateMigrate.js";
import { ignoreHunchMemory, HUNCH_MEMORY_DIRS } from "../src/integrations/gitignore.js";
import type { Decision, Constraint } from "../src/core/types.js";

const CON = (id: string, statement: string): Constraint => ({
  id, type: "correctness", statement, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
  rationale: "", source_decision: null, violations: [], status: "active",
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
} as unknown as Constraint);

const DEC = (id: string, title: string): Decision => ({
  id, title, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  date: "2026-01-01T00:00:00Z",
} as unknown as Decision);

function stores(): { pub: JsonStore; priv: JsonStore; roots: string[]; cleanup: () => void } {
  const pubRoot = mkdtempSync(join(tmpdir(), "hunch-mig-pub-"));
  const privRoot = mkdtempSync(join(tmpdir(), "hunch-mig-priv-"));
  const pub = new JsonStore(hunchPaths(pubRoot));
  const priv = new JsonStore(hunchPathsForDir(join(privRoot, ".hunch")));
  pub.ensureDirs();
  priv.ensureDirs();
  return {
    pub, priv, roots: [pubRoot, privRoot],
    cleanup: () => { rmSync(pubRoot, { recursive: true, force: true }); rmSync(privRoot, { recursive: true, force: true }); },
  };
}

test("private --migrate: unions public records into the overlay, preserving private-only records", () => {
  const { pub, priv, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_pub", "public decision"));
    pub.put("constraints", CON("con_pub", "public constraint"));
    priv.put("decisions", DEC("dec_priv", "private-only decision"));

    const res = movePublicMemoryToPrivate(pub, priv);

    assert.equal(res.moved.decisions, 1);
    assert.equal(res.moved.constraints, 1);
    assert.equal(res.total, 2);
    assert.deepEqual(priv.loadAll("decisions").map((d) => d.id).sort(), ["dec_priv", "dec_pub"]); // union
    assert.deepEqual(priv.loadAll("constraints").map((c) => c.id), ["con_pub"]);
  } finally { cleanup(); }
});

test("private --migrate: a record present in BOTH stores is absorbed once, not duplicated", () => {
  const { pub, priv, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_shared", "from public"));
    priv.put("decisions", DEC("dec_shared", "from private"));
    movePublicMemoryToPrivate(pub, priv);
    const ids = priv.loadAll("decisions").map((d) => d.id);
    assert.deepEqual(ids, ["dec_shared"]); // single record, no duplicate id
  } finally { cleanup(); }
});

test("private --migrate: never writes to the public store; dropAll empties it afterward", () => {
  const { pub, priv, roots: [pubRoot], cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_pub", "public"));
    pub.put("constraints", CON("con_pub", "public constraint"));

    movePublicMemoryToPrivate(pub, priv);
    // move() copies, never deletes — the public store still has its records here.
    assert.equal(pub.loadAll("decisions").length, 1);
    assert.equal(pub.loadAll("constraints").length, 1);

    // the CLI empties the public store only after the move returns.
    for (const kind of ["components", "edges", "symbols", "decisions", "bugs", "constraints"] as const) pub.dropAll(kind);
    assert.equal(pub.loadAll("decisions").length, 0);
    assert.equal(pub.loadAll("constraints").length, 0);
    const decDir = join(pubRoot!, ".hunch", "decisions");
    assert.ok(!readdirSync(decDir).some((f) => f.endsWith(".json")), "public decisions dir still has JSON files");
  } finally { cleanup(); }
});

test("private --migrate: ignoreHunchMemory adds the memory tree once and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mig-gi-"));
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const first = ignoreHunchMemory(root);
    assert.equal(first.action, "appended");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    for (const dir of HUNCH_MEMORY_DIRS) assert.match(gi, new RegExp(`^${dir.replace(/[.]/g, "\\.")}/$`, "m"));

    const second = ignoreHunchMemory(root);
    assert.equal(second.action, "unchanged"); // re-running is a no-op
    const occurrences = readFileSync(join(root, ".gitignore"), "utf8").split("private-only").length - 1;
    assert.equal(occurrences, 2); // exactly one marked block (START + END markers)
  } finally { rmSync(root, { recursive: true, force: true }); }
});
