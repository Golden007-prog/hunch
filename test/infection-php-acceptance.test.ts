import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { scanRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

interface AcceptanceTarget {
  id: string;
  repository: string;
  source: { kind: "commit"; revision: string; content_hash: string };
  result: ReturnType<typeof scanRepo>["result"];
  issues: ReturnType<typeof scanRepo>["issues"];
}

interface AcceptanceReceipt {
  schema: string;
  targets: AcceptanceTarget[];
  behavioral_probes: {
    infection_path: { hops: number; relationship: string; observed_seconds: number };
    infection_commit_impact: { changed_files: number; dependent_files: number; observed_seconds: number };
    infection_shortlist: { files_read: number; files_skipped: number; exact_owner_enabled: boolean; verdict: string };
  };
  human_signoff: { status: string; reviewer: string | null; signed_at: string | null };
}

const receipt = JSON.parse(readFileSync(new URL("../bench/infection/php-index-acceptance-v1.json", import.meta.url), "utf8")) as AcceptanceReceipt;

test("frozen PHP acceptance receipt records two exact revisions and preserves uncertainty", () => {
  assert.equal(receipt.schema, "hunch.php-index-acceptance/1");
  assert.deepEqual(receipt.targets.map(({ id, source }) => ({ id, revision: source.revision })), [
    { id: "infection", revision: "49a4923cc01da30d165b100d6270b77c0a54429e" },
    { id: "composer", revision: "53e6ddca87c033e2db254c8773124d1d7afed08d" },
  ]);
  const infection = receipt.targets[0]!;
  const composer = receipt.targets[1]!;
  assert.deepEqual(infection.result.coverage[0], {
    language: "php", eligible: 1823, parsed: 1822, skipped: 1, reasons: { symlink: 1 },
  });
  assert.deepEqual(infection.issues.map(({ path, code }) => ({ path, code })), [{
    path: "tests/phpunit/Source/Collector/BasicSourceCollector/Fixtures/case0/outside-symlink.php",
    code: "symlink",
  }]);
  assert.deepEqual(composer.result.coverage[0], {
    language: "php", eligible: 622, parsed: 622, skipped: 0, reasons: {},
  });
  assert.equal(receipt.behavioral_probes.infection_path.hops, 1);
  assert.equal(receipt.behavioral_probes.infection_path.relationship, "implements");
  assert.ok(receipt.behavioral_probes.infection_path.observed_seconds > 0);
  assert.equal(receipt.behavioral_probes.infection_commit_impact.dependent_files, 105);
  assert.ok(receipt.behavioral_probes.infection_commit_impact.observed_seconds > 0);
  assert.equal(receipt.behavioral_probes.infection_shortlist.files_read, 621);
  assert.equal(receipt.behavioral_probes.infection_shortlist.files_skipped, 0);
  assert.equal(receipt.behavioral_probes.infection_shortlist.exact_owner_enabled, false);
  assert.equal(receipt.behavioral_probes.infection_shortlist.verdict, "coverage-only-no-accuracy-promotion");
  assert.deepEqual(receipt.human_signoff, { status: "required", reviewer: null, signed_at: null });
});

function verifyExactTarget(target: AcceptanceTarget, root: string): void {
  const store = new HunchStore(hunchPaths(root));
  try {
    const scan = scanRepo(store, root, { churn: false, source: { kind: "commit", ref: target.source.revision } });
    assert.deepEqual({ source: scan.source, result: scan.result, issues: scan.issues }, {
      source: target.source,
      result: target.result,
      issues: target.issues,
    });
  } finally {
    store.close();
  }
}

test("Infection exact revision reproduces the frozen PHP receipt", {
  skip: process.env.HUNCH_INFECTION_REPO ? false : "set HUNCH_INFECTION_REPO to run the external acceptance scan",
}, () => verifyExactTarget(receipt.targets[0]!, process.env.HUNCH_INFECTION_REPO!));

test("Composer exact revision reproduces the frozen PHP receipt", {
  skip: process.env.HUNCH_COMPOSER_REPO ? false : "set HUNCH_COMPOSER_REPO to run the external acceptance scan",
}, () => verifyExactTarget(receipt.targets[1]!, process.env.HUNCH_COMPOSER_REPO!));
