import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeliveryEnvelope,
  buildDeliveryEnvelope,
} from "../src/core/delivery.js";
import {
  assertLandscapeDeliveryFragment,
  landscapeFragmentHash,
  selectReviewedLandscape,
} from "../src/core/landscapeDelivery.js";
import { resourceId, resourceRelationshipId } from "../src/core/ids.js";
import {
  EdgeSchema,
  ResourceSchema,
  type Edge,
  type Resource,
} from "../src/core/types.js";
import type { AssembledContext } from "../src/store/hunchStore.js";

const revision = "a".repeat(40);
const reviewedAt = "2026-08-26T15:00:00.000Z";
const candidateHash = `sha256:${"b".repeat(64)}`;
const discoveryHash = `sha256:${"c".repeat(64)}`;
const reviewId = `lr_${"d".repeat(24)}`;

function reviewedResource(kind: string, key: string, name: string, scope: string[] = []): Resource {
  return ResourceSchema.parse({
    schema: "hunch.resource/1",
    id: resourceId(kind, key),
    kind,
    name,
    scope,
    locator: key,
    lifecycle: "active",
    provenance: {
      source: "extracted:test+human_confirmed",
      confidence: 0.95,
      evidence: [`fixture.json#${key}@${revision}:${candidateHash}`],
      last_verified: reviewedAt,
    },
    currentness: {
      status: "current",
      verified_at: reviewedAt,
      source_revision: revision,
      source_content_hash: candidateHash,
    },
    metadata: {
      discovery_authority: "human_confirmed",
      landscape_candidate_hash: candidateHash,
      landscape_discovery_hash: discoveryHash,
      landscape_review_id: reviewId,
      landscape_reviewed_by: "platform-team",
      landscape_reviewed_at: reviewedAt,
    },
    created_at: reviewedAt,
    updated_at: reviewedAt,
  });
}

function reviewedRelationship(from: string, to: string, type: "contains" | "builds"): Edge {
  return EdgeSchema.parse({
    schema: "hunch.resource-relationship/1",
    id: resourceRelationshipId(from, to, type),
    from,
    to,
    type,
    reason: `reviewed ${type} declaration`,
    strength: 0.9,
    provenance: {
      source: "extracted:test+human_confirmed",
      confidence: 0.95,
      evidence: [`fixture.json#${type}@${revision}:${candidateHash}`],
      last_verified: reviewedAt,
    },
    currentness: {
      status: "current",
      verified_at: reviewedAt,
      source_revision: revision,
      source_content_hash: candidateHash,
    },
    environment: null,
    metadata: {
      discovery_authority: "human_confirmed",
      landscape_candidate_hash: candidateHash,
      landscape_discovery_hash: discoveryHash,
      landscape_review_id: reviewId,
      landscape_reviewed_by: "platform-team",
      landscape_reviewed_at: reviewedAt,
    },
  });
}

function assembled(landscape: ReturnType<typeof selectReviewedLandscape>, budget_tokens = 1_500): AssembledContext {
  return {
    target: landscape.target,
    constraints: [],
    decisions: [],
    bugs: [],
    blast_radius: [],
    components: [],
    findings: [],
    landscape,
    budget_tokens,
  };
}

function resealEnvelope<T extends ReturnType<typeof buildDeliveryEnvelope>>(envelope: T): T {
  const { receipt_id: _receiptId, ...unsigned } = envelope;
  const digest = landscapeFragmentHash(unsigned);
  return {
    ...envelope,
    receipt_id: `hdr_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
  };
}

test("HLG-3 delivers only current reviewed graph records through the canonical budgeted envelope", () => {
  const repository = reviewedResource("repository", "github.com/acme/payments", "Payments repository");
  const api = reviewedResource("api", "openapi.yaml", "Payments API", [repository.id]);
  const pipeline = reviewedResource("pipeline", ".github/workflows/ci.yml", "Payments CI", [repository.id]);
  const unreviewed = ResourceSchema.parse({
    ...reviewedResource("database", "payments", "Payments database", [repository.id]),
    provenance: { source: "extracted:test", confidence: 0.8, evidence: [] },
    currentness: { status: "unverified", source_revision: revision },
    metadata: { discovery_authority: "candidate" },
  });
  const stale = ResourceSchema.parse({
    ...reviewedResource("runbook", "runbooks/payments.md", "Payments runbook", [repository.id]),
    currentness: {
      status: "stale",
      verified_at: reviewedAt,
      source_revision: revision,
      source_content_hash: candidateHash,
    },
  });
  const relationships = [
    reviewedRelationship(repository.id, api.id, "contains"),
    reviewedRelationship(repository.id, pipeline.id, "builds"),
  ];
  const selection = selectReviewedLandscape(
    [repository, api, pipeline, unreviewed, stale],
    relationships,
    "payments api",
  );
  assert.deepEqual(selection.resources.map((item) => item.record.id), [api.id, pipeline.id, repository.id]);
  assert.ok(!JSON.stringify(selection).includes(unreviewed.id));
  assert.ok(!JSON.stringify(selection).includes(stale.id));

  const first = buildDeliveryEnvelope(assembled(selection));
  const replay = buildDeliveryEnvelope(assembled(selection));
  assert.equal(first.schema_version, "hunch.delivery-envelope/1");
  assert.match(first.receipt_id, /^hdr_[a-f0-9]{24}$/);
  assert.equal(replay.receipt_id, first.receipt_id, "the same exact delivery has one stable receipt identity");
  assert.ok(first.landscape);
  assert.equal(first.landscape.schema, "hunch.landscape-fragment/1");
  assert.equal(first.landscape.authority, "human_confirmed");
  assert.deepEqual(first.landscape.reviewIds, [reviewId]);
  assert.deepEqual(first.landscape.discoveryHashes, [discoveryHash]);
  assert.deepEqual(first.landscape.sourceRevisions, [revision]);
  assert.ok(first.landscape.resources.every((item) => item.required === false && item.blocking === false));
  assert.ok(first.landscape.resources.every((item) => item.provenanceStatus === "current"));
  assert.ok(first.landscape.relationships.every((item) => {
    const ids = new Set(first.landscape!.resources.map((resource) => resource.record.id));
    return ids.has(item.record.from) && ids.has(item.record.to);
  }));
  assert.ok(first.accounted_chars <= first.budget_tokens * 4);
  assert.ok(first.used_chars <= first.accounted_chars);
  assert.doesNotThrow(() => assertLandscapeDeliveryFragment(first.landscape!));
  assert.doesNotThrow(() => assertDeliveryEnvelope(first));

  const tampered = structuredClone(first);
  tampered.landscape!.resources[0]!.record.name = "Changed after delivery";
  assert.throws(() => assertDeliveryEnvelope(tampered), /content hash|receipt/i);
});

test("HLG-3 reserves one bounded resource slot for the reviewed repository root", () => {
  const repository = reviewedResource("repository", "github.com/acme/payments", "Payments repository");
  const matches = Array.from({ length: 5 }, (_, index) =>
    reviewedResource("service", `authentication-${index}`, `Authentication service ${index}`, [repository.id]));
  const selection = selectReviewedLandscape([repository, ...matches], [], "authentication service", 8);

  assert.equal(selection.resources.length, 5);
  assert.equal(selection.resources.at(-1)?.record.id, repository.id);
  assert.equal(selection.resources.filter((item) => matches.some((match) => match.id === item.record.id)).length, 4);
  assert.ok(selection.omitted.some((item) => item.recordId === matches.at(-1)?.id && item.reason === "landscape-cap"));
});

test("HLG-3 rejects re-signed duplicate or substituted landscape delivery entries", () => {
  const repository = reviewedResource("repository", "github.com/acme/payments", "Payments repository");
  const api = reviewedResource("api", "openapi.yaml", "Payments API", [repository.id]);
  const relationship = reviewedRelationship(repository.id, api.id, "contains");
  const envelope = buildDeliveryEnvelope(assembled(
    selectReviewedLandscape([repository, api], [relationship], "payments api"),
  ));
  assert.equal(envelope.delivered.length, 3);

  const duplicate = structuredClone(envelope);
  duplicate.delivered[1] = structuredClone(duplicate.delivered[0]!);
  assert.throws(
    () => assertDeliveryEnvelope(resealEnvelope(duplicate)),
    /inconsistent|one-to-one/i,
  );

  const substituted = structuredClone(envelope);
  substituted.delivered[0]!.delivery_reason = "blocking-reserved";
  assert.throws(
    () => assertDeliveryEnvelope(resealEnvelope(substituted)),
    /inconsistent/i,
  );
});

test("HLG-3 withholds relationships when the hard budget cannot carry both endpoints", () => {
  const repository = reviewedResource("repository", "github.com/acme/payments", "Payments repository");
  const api = reviewedResource("api", "openapi.yaml", "Payments API", [repository.id]);
  const relationship = reviewedRelationship(repository.id, api.id, "contains");
  const selection = selectReviewedLandscape([repository, api], [relationship], "payments api");
  const envelope = buildDeliveryEnvelope(assembled(selection, 260));

  assert.ok(envelope.accounted_chars <= 260 * 4);
  assert.equal(envelope.landscape?.relationships.length, 0);
  assert.ok(envelope.landscape?.omitted.some((item) =>
    item.kind === "relationships" && item.reason === "endpoint-not-delivered"));
  assert.doesNotThrow(() => assertDeliveryEnvelope(envelope));
});

test("HLG-3 preserves a tiny hard budget while exposing bounded omission evidence", () => {
  const repository = reviewedResource("repository", "github.com/acme/payments", "Payments repository");
  const selection = selectReviewedLandscape([repository], [], "payments");
  const envelope = buildDeliveryEnvelope(assembled(selection, 1));

  assert.ok(envelope.used_chars <= 4);
  assert.ok(envelope.accounted_chars <= 4);
  assert.deepEqual(envelope.delivered, []);
  assert.ok(envelope.landscape?.omitted.some((item) => item.recordId === repository.id && item.reason === "budget"));
  assert.doesNotThrow(() => assertDeliveryEnvelope(envelope));
});
