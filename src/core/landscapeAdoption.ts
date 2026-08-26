import { compareCodeUnits } from "./canonicalOrder.js";
import {
  EdgeSchema,
  ResourceSchema,
  isCredentialFreeText,
  type Edge,
  type Resource,
} from "./types.js";
import {
  LANDSCAPE_CANDIDATE_SCHEMA_VERSION,
  LANDSCAPE_DISCOVERY_SCHEMA_VERSION,
  landscapeContentHash,
  type LandscapeCandidate,
  type LandscapeDiscoveryResult,
} from "../extractors/landscapeDiscovery.js";

export const LANDSCAPE_REVIEW_SCHEMA_VERSION = "hunch.landscape-review/1" as const;
export const LANDSCAPE_ADOPTION_RECEIPT_SCHEMA_VERSION = "hunch.landscape-adoption-receipt/1" as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_SELECTIONS = 4_096;

export interface LandscapeReview {
  schema: typeof LANDSCAPE_REVIEW_SCHEMA_VERSION;
  authority: "human_confirmed";
  reviewId: string;
  reviewer: string;
  reviewedAt: string;
  discoveryHash: string;
  sourceRevision: string;
  repositoryRootIdentity: string;
  selectedCandidateHashes: string[];
  acknowledgedIssueCodes: string[];
}

export interface LandscapeAdoptionReceipt {
  schema: typeof LANDSCAPE_ADOPTION_RECEIPT_SCHEMA_VERSION;
  authority: "human_confirmed";
  receiptId: string;
  review: LandscapeReview;
  acceptedResourceIds: string[];
  acceptedRelationshipIds: string[];
  writtenResourceIds: string[];
  writtenRelationshipIds: string[];
  reusedResourceIds: string[];
  reusedRelationshipIds: string[];
}

export interface LandscapeAdoptionPlan {
  receipt: LandscapeAdoptionReceipt;
  resourcesToWrite: Resource[];
  relationshipsToWrite: Edge[];
}

export interface PlanLandscapeAdoptionInput {
  discovery: LandscapeDiscoveryResult;
  expectedDiscoveryHash: string;
  reviewer: string;
  reviewedAt?: string;
  /** `all` remains an explicit operator choice; otherwise every hash is named. */
  candidateHashes: "all" | string[];
  acknowledgeIssues?: boolean;
  existingResources?: Resource[];
  existingRelationships?: Edge[];
}

function sortedUnique(values: string[], label: string): string[] {
  if (values.length > MAX_SELECTIONS) throw new Error(`landscape ${label} exceeds the bounded selection limit`);
  const ordered = [...values].sort(compareCodeUnits);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] === ordered[index - 1]) throw new Error(`landscape ${label} contains a duplicate: ${ordered[index]}`);
  }
  return ordered;
}

function candidateUnsigned<T extends Resource | Edge>(candidate: LandscapeCandidate<T>) {
  return {
    schema: candidate.schema,
    authority: candidate.authority,
    record: candidate.record,
    evidence: candidate.evidence,
  };
}

/** Refuse a result that was changed after exact-revision discovery. */
export function assertLandscapeDiscoveryIntegrity(discovery: LandscapeDiscoveryResult): void {
  if (discovery.schema !== LANDSCAPE_DISCOVERY_SCHEMA_VERSION || discovery.authority !== "candidate") {
    throw new Error("landscape adoption requires a candidate discovery result");
  }
  if (!/^[a-f0-9]{40,64}$/.test(discovery.sourceRevision)) {
    throw new Error("landscape discovery source revision is not an exact Git commit");
  }
  if (!discovery.repositoryRootIdentity || discovery.repositoryRootIdentity.length > 2_048
    || !isCredentialFreeText(discovery.repositoryRootIdentity)) {
    throw new Error("landscape discovery repository identity is invalid");
  }
  for (const candidate of discovery.resources) ResourceSchema.parse(candidate.record);
  for (const candidate of discovery.relationships) EdgeSchema.parse(candidate.record);
  const allCandidates: Array<LandscapeCandidate<Resource | Edge>> = [...discovery.resources, ...discovery.relationships];
  const seenHashes = new Set<string>();
  const seenIds = new Set<string>();
  for (const candidate of allCandidates) {
    if (candidate.schema !== LANDSCAPE_CANDIDATE_SCHEMA_VERSION || candidate.authority !== "candidate") {
      throw new Error("landscape discovery contains a non-candidate record");
    }
    if (candidate.record.metadata.discovery_authority !== "candidate") {
      throw new Error(`landscape candidate ${candidate.record.id} does not retain candidate authority`);
    }
    if (candidate.record.currentness?.status !== "unverified"
      || candidate.record.currentness.source_revision !== discovery.sourceRevision) {
      throw new Error(`landscape candidate ${candidate.record.id} is not bound to the discovery revision`);
    }
    if (!candidate.evidence.length || candidate.evidence.length > 64
      || candidate.evidence.some((evidence) => evidence.sourceRevision !== discovery.sourceRevision)) {
      throw new Error(`landscape candidate ${candidate.record.id} has invalid revision evidence`);
    }
    const expected = landscapeContentHash(candidateUnsigned(candidate));
    if (candidate.candidateHash !== expected || !SHA256.test(candidate.candidateHash)) {
      throw new Error(`landscape candidate ${candidate.record.id} failed its content hash`);
    }
    if (seenHashes.has(candidate.candidateHash)) throw new Error(`landscape candidate hash is duplicated: ${candidate.candidateHash}`);
    if (seenIds.has(candidate.record.id)) throw new Error(`landscape candidate id is duplicated: ${candidate.record.id}`);
    seenHashes.add(candidate.candidateHash);
    seenIds.add(candidate.record.id);
  }
  const unsigned = {
    schema: discovery.schema,
    authority: discovery.authority,
    sourceRevision: discovery.sourceRevision,
    repositoryRootIdentity: discovery.repositoryRootIdentity,
    resources: discovery.resources,
    relationships: discovery.relationships,
    issues: discovery.issues,
  };
  if (discovery.discoveryHash !== landscapeContentHash(unsigned) || !SHA256.test(discovery.discoveryHash)) {
    throw new Error("landscape discovery failed its content hash");
  }
}

function reviewFor(input: PlanLandscapeAdoptionInput, selectedCandidateHashes: string[]): LandscapeReview {
  const reviewer = input.reviewer.trim();
  if (!reviewer || reviewer.length > 128 || !isCredentialFreeText(reviewer)) {
    throw new Error("landscape reviewer must be a credential-free label of 1-128 characters");
  }
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (reviewedAt.length > 64 || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error("landscape review timestamp must be ISO-compatible");
  }
  const acknowledgedIssueCodes = input.acknowledgeIssues
    ? [...new Set(input.discovery.issues.map((issue) => issue.code))].sort(compareCodeUnits)
    : [];
  const unsigned = {
    schema: LANDSCAPE_REVIEW_SCHEMA_VERSION,
    authority: "human_confirmed" as const,
    reviewer,
    reviewedAt,
    discoveryHash: input.discovery.discoveryHash,
    sourceRevision: input.discovery.sourceRevision,
    repositoryRootIdentity: input.discovery.repositoryRootIdentity,
    selectedCandidateHashes,
    acknowledgedIssueCodes,
  };
  return { ...unsigned, reviewId: `lr_${landscapeContentHash(unsigned).slice("sha256:".length, "sha256:".length + 24)}` };
}

function acceptedMetadata(
  metadata: Resource["metadata"] | Edge["metadata"],
  candidateHash: string,
  discoveryHash: string,
  review: Pick<LandscapeReview, "reviewId" | "reviewer" | "reviewedAt">,
) {
  return {
    ...metadata,
    discovery_authority: "human_confirmed",
    landscape_candidate_hash: candidateHash,
    landscape_discovery_hash: discoveryHash,
    landscape_review_id: review.reviewId,
    landscape_reviewed_by: review.reviewer,
    landscape_reviewed_at: review.reviewedAt,
  };
}

function acceptedResource(
  candidate: LandscapeCandidate<Resource>,
  discoveryHash: string,
  review: Pick<LandscapeReview, "reviewId" | "reviewer" | "reviewedAt">,
): Resource {
  return ResourceSchema.parse({
    ...candidate.record,
    provenance: {
      ...candidate.record.provenance,
      source: `${candidate.record.provenance.source}+human_confirmed`,
      confidence: Math.max(candidate.record.provenance.confidence, 0.95),
      last_verified: review.reviewedAt,
    },
    metadata: acceptedMetadata(candidate.record.metadata, candidate.candidateHash, discoveryHash, review),
    currentness: {
      ...candidate.record.currentness,
      status: "current",
      verified_at: review.reviewedAt,
    },
    updated_at: review.reviewedAt,
  });
}

function acceptedRelationship(
  candidate: LandscapeCandidate<Edge>,
  discoveryHash: string,
  review: Pick<LandscapeReview, "reviewId" | "reviewer" | "reviewedAt">,
): Edge {
  return EdgeSchema.parse({
    ...candidate.record,
    provenance: {
      ...candidate.record.provenance,
      source: `${candidate.record.provenance.source}+human_confirmed`,
      confidence: Math.max(candidate.record.provenance.confidence, 0.95),
      last_verified: review.reviewedAt,
    },
    metadata: acceptedMetadata(candidate.record.metadata, candidate.candidateHash, discoveryHash, review),
    currentness: {
      ...candidate.record.currentness,
      status: "current",
      verified_at: review.reviewedAt,
    },
  });
}

function sameAcceptedCandidate(
  record: Resource | Edge,
  candidate: LandscapeCandidate<Resource> | LandscapeCandidate<Edge>,
  discoveryHash: string,
): boolean {
  const reviewId = record.metadata.landscape_review_id;
  const reviewer = record.metadata.landscape_reviewed_by;
  const reviewedAt = record.metadata.landscape_reviewed_at;
  if (typeof reviewId !== "string" || !/^lr_[a-f0-9]{24}$/.test(reviewId)
    || typeof reviewer !== "string" || !reviewer || reviewer.length > 128 || !isCredentialFreeText(reviewer)
    || typeof reviewedAt !== "string" || !Number.isFinite(Date.parse(reviewedAt))) return false;
  const review = { reviewId, reviewer, reviewedAt };
  const expected = record.schema === "hunch.resource/1"
    ? acceptedResource(candidate as LandscapeCandidate<Resource>, discoveryHash, review)
    : acceptedRelationship(candidate as LandscapeCandidate<Edge>, discoveryHash, review);
  // Metadata hashes are evidence, not self-authenticating proof. Reuse only
  // when the entire reviewed record still equals the candidate-derived value.
  return landscapeContentHash(record) === landscapeContentHash(expected);
}

/**
 * Convert an exact candidate discovery into a prevalidated write plan.
 *
 * Planning has no side effects. The caller persists only `resourcesToWrite` and
 * `relationshipsToWrite` through the ordinary Hunch capture boundary after this
 * function has proved every selection, endpoint and existing-record conflict.
 */
export function planLandscapeAdoption(input: PlanLandscapeAdoptionInput): LandscapeAdoptionPlan {
  assertLandscapeDiscoveryIntegrity(input.discovery);
  if (input.expectedDiscoveryHash !== input.discovery.discoveryHash) {
    throw new Error("landscape discovery changed after review; review the current candidate set again");
  }
  if (input.discovery.issues.length > 0 && input.acknowledgeIssues !== true) {
    throw new Error(`landscape discovery has ${input.discovery.issues.length} issue(s); inspect them and explicitly acknowledge them before adoption`);
  }

  const allCandidates: Array<LandscapeCandidate<Resource | Edge>> = [
    ...input.discovery.resources,
    ...input.discovery.relationships,
  ];
  const allHashes = allCandidates.map((candidate) => candidate.candidateHash);
  const selectedCandidateHashes = input.candidateHashes === "all"
    ? [...allHashes].sort(compareCodeUnits)
    : sortedUnique(input.candidateHashes, "candidate selection");
  if (selectedCandidateHashes.length === 0) throw new Error("landscape adoption requires at least one selected candidate");
  const candidatesByHash = new Map(allCandidates.map((candidate) => [candidate.candidateHash, candidate]));
  for (const hash of selectedCandidateHashes) {
    if (!SHA256.test(hash) || !candidatesByHash.has(hash)) throw new Error(`landscape selection names an unknown candidate: ${hash}`);
  }

  const selected = new Set(selectedCandidateHashes);
  const selectedResources = input.discovery.resources.filter((candidate) => selected.has(candidate.candidateHash));
  const selectedRelationships = input.discovery.relationships.filter((candidate) => selected.has(candidate.candidateHash));
  const selectedResourceIds = new Set(selectedResources.map((candidate) => candidate.record.id));
  for (const candidate of selectedRelationships) {
    if (!selectedResourceIds.has(candidate.record.from) || !selectedResourceIds.has(candidate.record.to)) {
      throw new Error(`landscape relationship ${candidate.record.id} requires both endpoint resource candidates to be selected`);
    }
  }

  const review = reviewFor(input, selectedCandidateHashes);
  const existingResources = new Map<string, Resource>();
  for (const value of input.existingResources ?? []) {
    const record = ResourceSchema.parse(value);
    if (existingResources.has(record.id)) throw new Error(`landscape existing resources contain duplicate id: ${record.id}`);
    existingResources.set(record.id, record);
  }
  const existingRelationships = new Map<string, Edge>();
  for (const value of input.existingRelationships ?? []) {
    const record = EdgeSchema.parse(value);
    if (existingRelationships.has(record.id)) throw new Error(`landscape existing relationships contain duplicate id: ${record.id}`);
    existingRelationships.set(record.id, record);
  }
  const resourcesToWrite: Resource[] = [];
  const relationshipsToWrite: Edge[] = [];
  const reusedResourceIds: string[] = [];
  const reusedRelationshipIds: string[] = [];

  for (const candidate of selectedResources) {
    const existing = existingResources.get(candidate.record.id);
    if (existing) {
      if (!sameAcceptedCandidate(existing, candidate, input.discovery.discoveryHash)) {
        throw new Error(`landscape resource ${candidate.record.id} already exists with different reviewed content`);
      }
      reusedResourceIds.push(existing.id);
    } else {
      resourcesToWrite.push(acceptedResource(candidate, input.discovery.discoveryHash, review));
    }
  }
  for (const candidate of selectedRelationships) {
    const existing = existingRelationships.get(candidate.record.id);
    if (existing) {
      if (!sameAcceptedCandidate(existing, candidate, input.discovery.discoveryHash)) {
        throw new Error(`landscape relationship ${candidate.record.id} already exists with different reviewed content`);
      }
      reusedRelationshipIds.push(existing.id);
    } else {
      relationshipsToWrite.push(acceptedRelationship(candidate, input.discovery.discoveryHash, review));
    }
  }

  const receiptUnsigned = {
    schema: LANDSCAPE_ADOPTION_RECEIPT_SCHEMA_VERSION,
    authority: "human_confirmed" as const,
    review,
    acceptedResourceIds: selectedResources.map((candidate) => candidate.record.id).sort(compareCodeUnits),
    acceptedRelationshipIds: selectedRelationships.map((candidate) => candidate.record.id).sort(compareCodeUnits),
    writtenResourceIds: resourcesToWrite.map((record) => record.id).sort(compareCodeUnits),
    writtenRelationshipIds: relationshipsToWrite.map((record) => record.id).sort(compareCodeUnits),
    reusedResourceIds: reusedResourceIds.sort(compareCodeUnits),
    reusedRelationshipIds: reusedRelationshipIds.sort(compareCodeUnits),
  };
  const receiptId = `la_${landscapeContentHash(receiptUnsigned).slice("sha256:".length, "sha256:".length + 24)}`;
  return {
    receipt: { ...receiptUnsigned, receiptId },
    resourcesToWrite,
    relationshipsToWrite,
  };
}
