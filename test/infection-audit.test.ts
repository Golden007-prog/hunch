import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");

interface AuditReceipt {
  schema: string;
  repository: string;
  revision: string;
  hunch: { version: string; implementation_revision: string };
  inputs: Record<"adr_receipt" | "php_receipt", { path: string; sha256: string }>;
  results: {
    adr_import: {
      records: number;
      excluded: string[];
      warnings: number;
      live: number;
      historical: number;
      mapped_statuses: Record<string, number>;
      current_policy_retrieval: {
        current: { decision_id: string; path: string; rank: number };
        superseded: { decision_id: string; path: string; rank: number };
      };
    };
    php_index: { files: number; symbols: number; edges: number; components: number; skipped: number; coverage: unknown[] };
    graph_probes: {
      structure: { indexed_files: number };
      path: { hops: number; relationship: string };
      impact: { changed_files: number; dependent_files: number };
      shortlist: { files_read: number; files_skipped: number; candidates: number; exact_owner_enabled: boolean };
      history_backfill: { changed_php_files: number; files_bound_to_commit: number };
    };
  };
  limitations: Array<{ code: string }>;
  verdict: string;
  human_signoff: {
    status: string;
    reviewer: string | null;
    signed_at: string | null;
    corpus_records_reviewed: number;
    live_reviews: { approved: number; declined: number; remaining: number };
    approvals: Array<{ decision_id: string; source_hash: string; review_hash: string }>;
  };
}

interface AdrReceipt {
  repository: string;
  revision: string;
  records: Array<{ path: string; decision_id: string; mapped_status: string }>;
  excluded: Array<{ path: string }>;
  human_signoff: { status: string; reviewer: string | null; signed_at: string | null };
}

interface PhpReceipt {
  targets: Array<{ id: string; source: { revision: string }; result: AuditReceipt["results"]["php_index"] }>;
}

const audit = readJson("bench/infection/audit-v1.json") as AuditReceipt;
const adr = readJson(audit.inputs.adr_receipt.path) as AdrReceipt;
const php = readJson(audit.inputs.php_receipt.path) as PhpReceipt;

test("the final Infection audit is content-bound, complete, and human-signed", () => {
  assert.equal(audit.schema, "hunch.infection-audit/1");
  assert.equal(audit.repository, "https://github.com/infection/infection");
  assert.equal(audit.revision, "49a4923cc01da30d165b100d6270b77c0a54429e");
  assert.equal(audit.hunch.version, "1.20.0-rc.4");
  assert.match(audit.hunch.implementation_revision, /^[0-9a-f]{40}$/);
  for (const input of Object.values(audit.inputs)) {
    assert.equal(sha256(input.path), input.sha256, input.path);
  }

  assert.equal(adr.repository, audit.repository);
  assert.equal(adr.revision, audit.revision);
  assert.equal(audit.results.adr_import.records, adr.records.length);
  assert.deepEqual(audit.results.adr_import.excluded, adr.excluded.map(({ path }) => path));
  assert.equal(audit.results.adr_import.warnings, 0);
  const statuses = Object.fromEntries(["accepted", "proposed", "superseded", "rejected"].map((status) => [
    status,
    adr.records.filter((record) => record.mapped_status === status).length,
  ]));
  assert.deepEqual(audit.results.adr_import.mapped_statuses, statuses);
  assert.equal(audit.results.adr_import.live, statuses.accepted);
  assert.equal(audit.results.adr_import.historical, adr.records.length - statuses.accepted);

  const current = audit.results.adr_import.current_policy_retrieval.current;
  const superseded = audit.results.adr_import.current_policy_retrieval.superseded;
  assert.ok(adr.records.some((record) => record.path === current.path && record.decision_id === current.decision_id));
  assert.ok(adr.records.some((record) => record.path === superseded.path && record.decision_id === superseded.decision_id));
  assert.ok(current.rank < superseded.rank);

  const infection = php.targets.find((target) => target.id === "infection")!;
  assert.equal(infection.source.revision, audit.revision);
  assert.deepEqual(audit.results.php_index, infection.result);
  assert.equal(audit.results.graph_probes.structure.indexed_files, 617);
  assert.deepEqual(audit.results.graph_probes.path, { from: "GitDiffSourceLineMatcher", to: "SourceLineMatcher", hops: 1, relationship: "implements" });
  assert.deepEqual(audit.results.graph_probes.impact, { commit: "HEAD", changed_files: 12, dependent_files: 105 });
  assert.equal(audit.results.graph_probes.shortlist.files_read, 621);
  assert.equal(audit.results.graph_probes.shortlist.files_skipped, 0);
  assert.ok(audit.results.graph_probes.shortlist.candidates > 0);
  assert.equal(audit.results.graph_probes.shortlist.exact_owner_enabled, false);
  assert.equal(audit.results.graph_probes.history_backfill.changed_php_files, audit.results.graph_probes.history_backfill.files_bound_to_commit);

  assert.deepEqual(audit.limitations.map(({ code }) => code), [
    "tracked_external_symlink",
    "dynamic_dispatch_unresolved",
    "shortlist_advisory_only",
  ]);
  assert.equal(audit.verdict, "passed_with_limitations");
  assert.equal(adr.human_signoff.status, "signed");
  assert.deepEqual({ status: audit.human_signoff.status, reviewer: audit.human_signoff.reviewer, signed_at: audit.human_signoff.signed_at }, {
    status: adr.human_signoff.status,
    reviewer: adr.human_signoff.reviewer,
    signed_at: adr.human_signoff.signed_at,
  });
  assert.equal(audit.human_signoff.corpus_records_reviewed, adr.records.length);
  assert.deepEqual(audit.human_signoff.live_reviews, { approved: audit.results.adr_import.live, declined: 0, remaining: 0 });
  const acceptedById = new Map(adr.records
    .filter((record) => record.mapped_status === "accepted")
    .map((record) => [record.decision_id, record]));
  assert.equal(audit.human_signoff.approvals.length, acceptedById.size);
  assert.deepEqual(new Set(audit.human_signoff.approvals.map(({ decision_id }) => decision_id)), new Set(acceptedById.keys()));
  for (const approval of audit.human_signoff.approvals) {
    assert.equal(approval.source_hash, `sha256:${acceptedById.get(approval.decision_id)!.sha256}`);
    assert.match(approval.review_hash, /^sha256:[0-9a-f]{64}$/);
  }
});
