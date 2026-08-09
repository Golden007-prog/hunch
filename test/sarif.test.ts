/**
 * SARIF rendering for `hunch check --format sarif` — the pure renderer only.
 * Covers: document shape (schema/version/driver), severity-truth level mapping
 * (error = would fail strict; warning = downgraded/warning-severity; note =
 * advisory), rule deduplication, receipts carried into messages, POSIX
 * location URIs, the extras families (conformance, policy, incomplete-scan),
 * and a clean report emitting zero results but a valid document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSarif, type CheckReport } from "../src/core/checkreport.js";

const empty: CheckReport = {
  fileCount: 0, strict: true, direct: [], near: [], regressions: [], vetoes: [],
  redundant: [], strictBlockers: 0, regBlocking: 0, vetoBlocking: 0,
};

interface SarifDoc {
  $schema: string;
  version: string;
  runs: Array<{
    tool: { driver: { name: string; version: string; rules: Array<{ id: string; defaultConfiguration: { level: string } }> } };
    results: Array<{ ruleId: string; level: string; message: { text: string }; locations?: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }>;
  }>;
}

const parse = (json: string): SarifDoc => JSON.parse(json) as SarifDoc;

test("clean report renders a valid empty SARIF document", () => {
  const doc = parse(renderSarif(empty, "9.9.9"));
  assert.equal(doc.version, "2.1.0");
  assert.ok(doc.$schema.includes("sarif-2.1.0"));
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.runs[0]!.tool.driver.name, "hunch");
  assert.equal(doc.runs[0]!.tool.driver.version, "9.9.9");
  assert.deepEqual(doc.runs[0]!.results, []);
  assert.deepEqual(doc.runs[0]!.tool.driver.rules, []);
});

test("level mapping is severity truth: strict-blocking=error, downgraded=warning, advisory=note", () => {
  const r: CheckReport = {
    ...empty,
    fileCount: 2,
    direct: [
      { id: "con_aaa", severity: "blocking", statement: "no direct DB", rationale: "auth", files: ["src\\a.ts"], strictBlocks: true },
      { id: "con_bbb", severity: "blocking", statement: "stale one", rationale: "", files: ["src/b.ts"], strictBlocks: false, downgrade: "stale" },
      { id: "con_ccc", severity: "advisory", statement: "prefer x", rationale: "", files: [], strictBlocks: false },
    ],
    near: [{ id: "con_ddd", severity: "blocking", statement: "near thing", via: ["src/a.ts → src/c.ts"] }],
    redundant: [{ name: "parse", kind: "function", existingFile: "src/parse.ts" }],
    strictBlockers: 1,
  };
  const doc = parse(renderSarif(r, "1.0.0"));
  const byRule = new Map(doc.runs[0]!.results.map((x) => [x.ruleId, x]));
  assert.equal(byRule.get("con_aaa")!.level, "error");
  assert.equal(byRule.get("con_bbb")!.level, "warning");
  assert.ok(byRule.get("con_bbb")!.message.text.includes("advisory under strict: stale"));
  assert.equal(byRule.get("con_ccc")!.level, "note");
  assert.equal(byRule.get("con_ddd")!.level, "note");
  assert.equal(byRule.get("hunch/redundant-symbol")!.level, "note");
  // location URIs are POSIX regardless of the input separator
  assert.equal(byRule.get("con_aaa")!.locations![0]!.physicalLocation.artifactLocation.uri, "src/a.ts");
  // a finding with no file omits locations rather than inventing one
  assert.equal(byRule.get("con_ccc")!.locations, undefined);
});

test("regressions and vetoes map blocking→error, non-blocking→warning; rules dedupe by id", () => {
  const r: CheckReport = {
    ...empty,
    regressions: [
      { kind: "function", name: "oldParse", decision: "dec_x1", title: "retired parser", reason: "slow", blocking: true },
      { kind: "function", name: "oldParse2", decision: "dec_x1", title: "retired parser", reason: "slow", blocking: false },
    ],
    vetoes: [{ decision: "dec_v1", title: "chose sqlite", alternative: "use postgres", chosen: "sqlite", tier: "human", evidence: ["e1"], blocking: true }],
    regBlocking: 1, vetoBlocking: 1,
  };
  const doc = parse(renderSarif(r, "1.0.0"));
  const results = doc.runs[0]!.results;
  assert.equal(results.filter((x) => x.ruleId === "dec_x1").length, 2);
  assert.equal(doc.runs[0]!.tool.driver.rules.filter((x) => x.id === "dec_x1").length, 1);
  assert.equal(results.find((x) => x.message.text.includes("oldParse2"))!.level, "warning");
  const veto = results.find((x) => x.ruleId === "dec_v1")!;
  assert.equal(veto.level, "error");
  assert.ok(veto.message.text.includes("use postgres"));
});

test("extras: conformance=error with receipt, policy levels, incomplete scan=error", () => {
  const doc = parse(renderSarif(empty, "1.0.0", {
    conformance: [{ decision: "dec_conf", title: "routes never touch DB", detail: "list_orders now reaches get_session", why: "the 2am incident", bug: "bug_123" }],
    policies: [
      { id: "pol_ok", result: "satisfied", explanation: "holds", blocks: false, receipt: "sha1:abc" },
      { id: "pol_bad", result: "violated", explanation: "edge found", blocks: true, receipt: "sha1:def" },
      { id: "pol_err", result: "error", explanation: "cannot evaluate", blocks: false, receipt: "sha1:eee", gateError: "scan failed" },
    ],
    scanIssues: [{ path: "src/x.ts", detail: "unreadable", code: "EIO" }],
  }));
  const byRule = new Map(doc.runs[0]!.results.map((x) => [x.ruleId, x]));
  const conf = byRule.get("dec_conf")!;
  assert.equal(conf.level, "error");
  assert.ok(conf.message.text.includes("the 2am incident"));
  assert.ok(conf.message.text.includes("bug_123"));
  assert.equal(byRule.get("pol_ok")!.level, "note");
  assert.equal(byRule.get("pol_bad")!.level, "error");
  assert.ok(byRule.get("pol_bad")!.message.text.includes("sha1:def"));
  assert.equal(byRule.get("pol_err")!.level, "error");
  const scan = byRule.get("hunch/incomplete-scan")!;
  assert.equal(scan.level, "error");
  assert.equal(scan.locations![0]!.physicalLocation.artifactLocation.uri, "src/x.ts");
});
