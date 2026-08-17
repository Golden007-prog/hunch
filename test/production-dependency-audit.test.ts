import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertReviewedProductionImports,
  evaluateProductionAudit,
} from "../tooling/production-dependency-audit.mjs";

// Synthetic fixture, not a real advisory: the reviewed-exception mechanism (accept an
// exact match, fail closed on any drift) is tested here independent of whatever npm
// audit currently reports for real dependencies. Coupling this to live CVE data was
// exactly the trap that made the real REVIEWED_AUDIT_VULNERABILITIES allowlist go stale
// out from under this test file — an upstream fix changed the real advisory's shape
// without touching this file's assertions, and both had to be diagnosed together.
const FAKE_REVIEWED = Object.freeze({
  "fake-vulnerable-package": Object.freeze({
    severity: "moderate",
    isDirect: false,
    range: "<2.0.5",
    effects: Object.freeze(["fake-parent-package"]),
    nodes: Object.freeze(["node_modules/fake-parent-package/node_modules/fake-vulnerable-package"]),
    via: Object.freeze([Object.freeze({
      source: 9999999,
      name: "fake-vulnerable-package",
      dependency: "fake-vulnerable-package",
      title: "Fake advisory for test purposes only",
      url: "https://github.com/advisories/GHSA-0000-0000-0000",
      severity: "moderate",
      cwe: Object.freeze(["CWE-22"]),
      cvss: Object.freeze({ score: 5.9, vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N" }),
      range: "<2.0.5",
    })]),
    fixAvailable: Object.freeze({ name: "fake-parent-package", version: "1.24.3", isSemVerMajor: true }),
  }),
});

function reviewedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "fake-vulnerable-package": {
        name: "fake-vulnerable-package",
        severity: "moderate",
        isDirect: false,
        via: [{
          source: 9999999,
          name: "fake-vulnerable-package",
          dependency: "fake-vulnerable-package",
          title: "Fake advisory for test purposes only",
          url: "https://github.com/advisories/GHSA-0000-0000-0000",
          severity: "moderate",
          cwe: ["CWE-22"],
          cvss: { score: 5.9, vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N" },
          range: "<2.0.5",
        }],
        effects: ["fake-parent-package"],
        range: "<2.0.5",
        nodes: ["node_modules/fake-parent-package/node_modules/fake-vulnerable-package"],
        fixAvailable: { name: "fake-parent-package", version: "1.24.3", isSemVerMajor: true },
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
    },
  };
}

test("production audit accepts only an exact reviewed exception", () => {
  const result = evaluateProductionAudit(reviewedReport(), [], FAKE_REVIEWED);
  assert.deepEqual(result, {
    status: "passed",
    reviewed_vulnerable_packages: ["fake-vulnerable-package"],
    reviewed_advisory_sources: [9999999],
    unreviewed_vulnerabilities: 0,
  });
  assert.deepEqual(evaluateProductionAudit({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  }, [], FAKE_REVIEWED), {
    status: "passed",
    reviewed_vulnerable_packages: [],
    reviewed_advisory_sources: [],
    unreviewed_vulnerabilities: 0,
  }, "a fully fixed dependency tree remains valid without changing the allowlist");
});

test("production audit fails closed on advisory drift, new findings, and HTTP/Hono reachability", () => {
  const changed = reviewedReport();
  changed.vulnerabilities["fake-vulnerable-package"].severity = "high";
  changed.metadata.vulnerabilities.moderate = 0;
  changed.metadata.vulnerabilities.high = 1;
  assert.throws(() => evaluateProductionAudit(changed, [], FAKE_REVIEWED), /changed identity/);

  const unexpected = reviewedReport();
  unexpected.vulnerabilities["new-package"] = {
    name: "new-package",
    severity: "critical",
    isDirect: false,
    via: [],
    effects: [],
    range: "*",
    nodes: ["node_modules/new-package"],
  };
  unexpected.metadata.vulnerabilities.critical = 1;
  unexpected.metadata.vulnerabilities.total = 2;
  assert.throws(() => evaluateProductionAudit(unexpected, [], FAKE_REVIEWED), /unreviewed production vulnerability/);

  // the real (non-fake) REVIEWED_AUDIT_VULNERABILITIES allowlist is currently empty (no
  // live exception) — the old Hono finding shape must now be rejected as unreviewed,
  // proving the stale allowlist cleanup actually took effect.
  assert.throws(() => evaluateProductionAudit(reviewedReport()), /unreviewed production vulnerability/);

  for (const specifier of [
    "@hono/node-server/serve-static",
    "hono",
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "@modelcontextprotocol/sdk/server/express.js",
    "@modelcontextprotocol/sdk/server/auth/router.js",
  ]) {
    assert.throws(() => assertReviewedProductionImports([specifier]), /became reachable/,
      `${specifier} must stay disallowed regardless of the current reviewed-exception allowlist`);
  }
});

test("production dependency audit command validates the current lock and source boundary", () => {
  const run = spawnSync(process.execPath, ["tooling/production-dependency-audit.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.unreviewed_vulnerabilities, 0);
});
