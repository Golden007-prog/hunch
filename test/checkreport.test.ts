import { test } from "node:test";
import assert from "node:assert/strict";
import { renderText, renderMarkdown, reportFailsStrict, reportIsClean, type CheckReport } from "../src/core/checkreport.js";

const base = (over: Partial<CheckReport> = {}): CheckReport => ({
  fileCount: 3, strict: false, direct: [], near: [], regressions: [], vetoes: [], strictBlockers: 0, regBlocking: 0, vetoBlocking: 0, ...over,
});

test("clean report — both renderers say nothing is affected; not failing", () => {
  const r = base();
  assert.equal(reportIsClean(r), true);
  assert.equal(reportFailsStrict(r), false);
  assert.match(renderText(r), /touch no recorded invariants/);
  assert.match(renderMarkdown(r), /✅ This PR touches \*\*no recorded invariants\*\*/);
});

test("strict + a direct high-confidence blocking invariant → FAILS, both renderers flag it", () => {
  const r = base({
    strict: true,
    direct: [{ id: "con_004", severity: "blocking", statement: "Revocation must be server-side", rationale: "no JWT-only logout", files: ["src/auth/session.ts"], strictBlocks: true }],
    strictBlockers: 1,
  });
  assert.equal(reportFailsStrict(r), true);
  assert.match(renderText(r), /✗ 1 high-confidence blocking invariant/);
  const md = renderMarkdown(r);
  assert.match(md, /❌ \*\*This PR breaks 1 high-confidence blocking invariant/);
  assert.match(md, /con_004/);
});

test("strict + blocking but STALE → downgraded to advisory, NOT failing", () => {
  const r = base({
    strict: true,
    direct: [{ id: "con_x", severity: "blocking", statement: "X", rationale: "", files: ["a.ts"], strictBlocks: false, downgrade: "stale" }],
    strictBlockers: 0,
  });
  assert.equal(reportFailsStrict(r), false);
  assert.match(renderText(r), /\(advisory: stale\)/);
  assert.match(renderMarkdown(r), /advisory: record is stale/);
  assert.match(renderMarkdown(r), /not blocking/i);
});

test("near-only (blast radius) never blocks, even under strict", () => {
  const r = base({
    strict: true,
    near: [{ id: "con_n", severity: "blocking", statement: "N", via: ["a.ts → b.ts (foo, depth 1)"] }],
  });
  assert.equal(reportFailsStrict(r), false);
  assert.match(renderMarkdown(r), /Near-invariants/);
  assert.match(renderMarkdown(r), /never blocks/);
});

test("blocking-linked regression fails strict", () => {
  const r = base({
    strict: true,
    regressions: [{ kind: "symbol", name: "jwtDecode", decision: "dec_017", title: "Move to Redis sessions", reason: "removed JWT-only path", blocking: true }],
    regBlocking: 1,
  });
  assert.equal(reportFailsStrict(r), true);
  assert.match(renderMarkdown(r), /Re-introduces deliberately-retired code/);
  assert.match(renderMarkdown(r), /blocking-linked/);
});

test("non-strict never fails regardless of severity", () => {
  const r = base({
    strict: false,
    direct: [{ id: "con_b", severity: "blocking", statement: "B", rationale: "", files: ["a.ts"], strictBlocks: true }],
    strictBlockers: 1,
  });
  assert.equal(reportFailsStrict(r), false);
  assert.match(renderText(r), /Advisory/);
});
