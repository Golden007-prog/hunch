import assert from "node:assert/strict";
import test from "node:test";
import {
  UsefulnessObservationSchema,
  assertUsefulnessObservation,
  createUsefulnessObservation,
  usefulnessObservationFinding,
} from "../src/core/outcomeExperience.js";

const input = {
  episode: {
    provider: "orc",
    schemaVersion: "orc.eval-episode/1",
    episodeId: "eep_1234567890abcdef12345678",
    episodeHash: `sha256:${"1".repeat(64)}`,
    terminalAt: "2026-08-28T00:00:00.000Z",
    result: "fail" as const,
  },
  delivery: {
    receiptRef: `hunch-memory:hmctx_${"2".repeat(32)}`,
    receiptHash: `sha256:${"3".repeat(64)}`,
    graphRevision: "4".repeat(40),
    sourceRevision: "4".repeat(40),
    sourceContentHash: `sha256:${"5".repeat(64)}`,
  },
  record: {
    recordId: "dec_auth_boundary",
    recordKind: "decision",
    recordRevision: `sha256:${"6".repeat(64)}`,
    contentHash: `sha256:${"7".repeat(64)}`,
  },
  signal: "contradicted" as const,
  evidence: [{
    kind: "verification" as const,
    ref: "verification:run-123:auth-boundary",
    hash: `sha256:${"8".repeat(64)}`,
  }],
  observedAt: "2026-08-28T00:05:00.000Z",
  retainUntil: "2027-08-28T00:05:00.000Z",
  privacy: {
    payloadMode: "references_hashes_only" as const,
    rawTranscriptIncluded: false as const,
    rawProviderOutputIncluded: false as const,
  },
};

test("usefulness observations are deterministic, receipt-bound and content-addressed", () => {
  const first = createUsefulnessObservation(input);
  const replay = createUsefulnessObservation(structuredClone(input));
  assert.deepEqual(replay, first);
  assert.equal(first.observationId, "huo_19ce363abe890621a3e3f2fd");
  assert.equal(first.contentHash, "sha256:cdd859058cb14671e5bd6210c0280e89af6083d249781b5208d946c5d9c2d3f5");
  assert.equal(first.authority.behavioralEffect, "none");
  assert.equal(first.authority.mayChangeRanking, false);
  assert.equal(first.authority.mayPromoteKnowledge, false);
  assert.equal(first.authority.mayGrantAuthority, false);
  assert.doesNotThrow(() => assertUsefulnessObservation(first));
});

test("one episode/receipt/record identity conflicts visibly instead of minting a second key", () => {
  const contradicted = createUsefulnessObservation(input);
  const stale = createUsefulnessObservation({ ...input, signal: "stale" });
  assert.equal(stale.observationId, contradicted.observationId);
  assert.notEqual(stale.contentHash, contradicted.contentHash);
});

test("unsupported, unsafe, partial and tampered usefulness claims fail closed", () => {
  assert.throws(() => createUsefulnessObservation({ ...input, evidence: [] }), /requires evidence/);
  assert.throws(() => createUsefulnessObservation({
    ...input,
    delivery: { ...input.delivery, sourceRevision: "9".repeat(40) },
  }), /source revision is inconsistent/);
  assert.throws(() => createUsefulnessObservation({
    ...input,
    evidence: [{ ...input.evidence[0], ref: "https://user:password@example.test/proof" }],
  }), /credential material/);
  assert.equal(UsefulnessObservationSchema.safeParse({
    ...createUsefulnessObservation(input),
    policyActivation: true,
  }).success, false);
  const tampered = createUsefulnessObservation(input);
  tampered.record.recordRevision = `sha256:${"0".repeat(64)}`;
  assert.throws(() => assertUsefulnessObservation(tampered), /seal is invalid/);
});

test("only contradiction or staleness becomes an open advisory finding", () => {
  const contradicted = createUsefulnessObservation(input);
  const finding = usefulnessObservationFinding(contradicted);
  assert.ok(finding);
  assert.equal(finding.triage, "open");
  assert.equal(finding.severity, "high");
  assert.equal(finding.provenance.source, "outcome_experience+candidate");
  assert.equal(finding.violates_constraint, null);
  assert.equal(finding.spawned_decision, null);
  assert.ok(finding.evidence.includes(`usefulness:${contradicted.observationId}`));
  assert.ok(finding.evidence.includes(`usefulness-content:${contradicted.contentHash}`));
  assert.equal("enforcement" in finding, false);
  assert.equal("ranking" in finding, false);
  assert.equal("promotion" in finding, false);

  for (const signal of ["used", "prevented", "near_miss", "unused", "unknown"] as const) {
    const observation = createUsefulnessObservation({
      ...input,
      signal,
      evidence: signal === "unknown" ? [] : input.evidence,
    });
    assert.equal(usefulnessObservationFinding(observation), null, `${signal} must not manufacture a finding`);
  }
  const stale = usefulnessObservationFinding(createUsefulnessObservation({ ...input, signal: "stale" }));
  assert.equal(stale?.severity, "medium");
  assert.equal(stale?.triage, "open");
});
