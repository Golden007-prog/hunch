import assert from "node:assert/strict";
import test from "node:test";
import {
  LandscapeDriftCandidateSchema,
  assertLandscapeDriftCandidate,
  createLandscapeDriftCandidate,
  landscapeDriftCandidateFinding,
} from "../src/core/types.js";

const input = {
  resourceId: "repository:github.com/acme/identity-sdk",
  declaredRepositoryId: "github.com/acme/identity-sdk",
  observedRepositoryId: "github.com/acme/identity-platform",
  observation: {
    providerId: "github",
    observedAt: "2026-08-26T10:00:00.000Z",
    providerReceiptId: "sri_aaaaaaaaaaaaaaaaaaaaaaaa",
    providerReceiptHash: `sha256:${"1".repeat(64)}`,
    resolutionReceiptId: "lrr_bbbbbbbbbbbbbbbbbbbbbbbb",
    resolutionReceiptHash: `sha256:${"2".repeat(64)}`,
    resolutionSetHash: `sha256:${"3".repeat(64)}`,
  },
};

test("external repository drift candidates are deterministic, content-addressed and bounded", () => {
  const first = createLandscapeDriftCandidate(input);
  const replay = createLandscapeDriftCandidate(structuredClone(input));
  assert.deepEqual(replay, first);
  assert.match(first.candidateId, /^ldf_[a-f0-9]{24}$/);
  assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.authority, "finding_candidate");
  assert.equal(first.classification, "repository_identity_mismatch");
  assert.doesNotThrow(() => assertLandscapeDriftCandidate(first));
});

test("drift candidates reject agreement, credential material, unknown fields and tampering", () => {
  assert.throws(() => createLandscapeDriftCandidate({
    ...input,
    observedRepositoryId: input.declaredRepositoryId,
  }), /real identity mismatch/);
  assert.throws(() => createLandscapeDriftCandidate({
    ...input,
    observedRepositoryId: "https://user:password@github.com/acme/identity-platform",
  }), /credential material/);
  assert.equal(LandscapeDriftCandidateSchema.safeParse({
    ...createLandscapeDriftCandidate(input),
    extra: true,
  }).success, false);
  const tampered = createLandscapeDriftCandidate(input);
  tampered.observedRepositoryId = "github.com/acme/another";
  assert.throws(() => assertLandscapeDriftCandidate(tampered), /seal is invalid/);
});

test("intake becomes one advisory finding and never graph or policy authority", () => {
  const candidate = createLandscapeDriftCandidate(input);
  const finding = landscapeDriftCandidateFinding(candidate);
  assert.match(finding.id, /^fnd_[a-f0-9]{10}$/);
  assert.equal(finding.triage, "open");
  assert.equal(finding.severity, "medium");
  assert.equal(finding.provenance.source, "orc_observed+candidate");
  assert.equal(finding.affected_symbols[0], input.resourceId);
  assert.equal(finding.evidence.some((entry) => entry.includes(candidate.contentHash)), true);
  assert.equal("lifecycle" in finding, false);
  assert.equal("currentness" in finding, false);
  assert.equal("enforcement" in finding, false);
  assert.deepEqual(landscapeDriftCandidateFinding(structuredClone(candidate)), finding);
});
