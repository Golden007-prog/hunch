import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";
import {
  EdgeSchema,
  ResourceSchema,
  type Edge,
  type Resource,
} from "./types.js";

export const LANDSCAPE_FRAGMENT_SCHEMA_VERSION = "hunch.landscape-fragment/1" as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVIEW_ID = /^lr_[a-f0-9]{24}$/;
const DEFAULT_FRAGMENT_ITEMS = 8;
const MAX_FRAGMENT_ITEMS = 24;
const MAX_FRAGMENT_OMISSIONS = 16;

export type LandscapeSelectionReason = "exact-target" | "task-match" | "orientation-root" | "graph-neighbor";

export interface SelectedLandscapeResource {
  record: Resource;
  selectionReason: LandscapeSelectionReason;
  selectionRank: number;
}

export interface SelectedLandscapeRelationship {
  record: Edge;
  selectionReason: "graph-connection";
  selectionRank: number;
}

export interface LandscapeSelectionOmission {
  kind: "resources" | "relationships";
  recordId: string;
  reason: "landscape-cap";
  detail: string;
}

export interface ReviewedLandscapeSelection {
  schema: typeof LANDSCAPE_FRAGMENT_SCHEMA_VERSION;
  authority: "human_confirmed";
  target: string;
  resources: SelectedLandscapeResource[];
  relationships: SelectedLandscapeRelationship[];
  omitted: LandscapeSelectionOmission[];
}

export interface DeliveredLandscapeResource extends SelectedLandscapeResource {
  rank: number;
  deliveryReason: "ranked";
  required: false;
  blocking: false;
  provenanceStatus: "current";
  tokenCost: number;
}

export interface DeliveredLandscapeRelationship extends SelectedLandscapeRelationship {
  rank: number;
  deliveryReason: "ranked";
  required: false;
  blocking: false;
  provenanceStatus: "current";
  tokenCost: number;
}

export interface LandscapeFragmentOmission {
  kind: "resources" | "relationships";
  recordId: string;
  reason: "budget" | "stale-provenance" | "endpoint-not-delivered" | "landscape-cap";
  detail: string;
}

export interface LandscapeDeliveryFragment {
  schema: typeof LANDSCAPE_FRAGMENT_SCHEMA_VERSION;
  authority: "human_confirmed";
  target: string;
  resources: DeliveredLandscapeResource[];
  relationships: DeliveredLandscapeRelationship[];
  omitted: LandscapeFragmentOmission[];
  reviewIds: string[];
  discoveryHashes: string[];
  sourceRevisions: string[];
  fragmentHash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function landscapeFragmentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function reviewedCurrent(record: Resource | Edge): boolean {
  return record.metadata.discovery_authority === "human_confirmed"
    && typeof record.metadata.landscape_candidate_hash === "string"
    && SHA256.test(record.metadata.landscape_candidate_hash)
    && typeof record.metadata.landscape_discovery_hash === "string"
    && SHA256.test(record.metadata.landscape_discovery_hash)
    && typeof record.metadata.landscape_review_id === "string"
    && REVIEW_ID.test(record.metadata.landscape_review_id)
    && record.currentness?.status === "current"
    && typeof record.currentness.source_revision === "string"
    && /^[a-f0-9]{40,64}$/.test(record.currentness.source_revision)
    && record.provenance.source.split("+").includes("human_confirmed");
}

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [])
    .map((token) => token.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean));
}

function relevance(resource: Resource, target: string, targetTokens: Set<string>): {
  score: number;
  reason: LandscapeSelectionReason;
} | null {
  const normalized = target.trim().toLowerCase();
  const fields = [resource.id, resource.name, resource.locator ?? "", ...resource.scope];
  if (fields.some((field) => field.toLowerCase() === normalized)) return { score: 1_000, reason: "exact-target" };
  const recordTokens = tokens(fields.join(" "));
  let overlap = 0;
  for (const token of targetTokens) if (recordTokens.has(token)) overlap++;
  if (overlap > 0) return { score: 700 + overlap * 20, reason: "task-match" };
  if (resource.kind === "repository" && resource.scope.length === 0) return { score: 500, reason: "orientation-root" };
  return null;
}

/**
 * Select a small orientation fragment from durable graph records.
 *
 * Candidate/unreviewed/stale records are excluded before ranking, so neither a
 * good lexical match nor a graph edge can accidentally upgrade their authority.
 */
export function selectReviewedLandscape(
  resources: readonly Resource[],
  relationships: readonly Edge[],
  target: string,
  maxItems = DEFAULT_FRAGMENT_ITEMS,
): ReviewedLandscapeSelection {
  const boundedItems = Number.isFinite(maxItems)
    ? Math.max(1, Math.min(MAX_FRAGMENT_ITEMS, Math.floor(maxItems)))
    : DEFAULT_FRAGMENT_ITEMS;
  const currentResources = resources
    .map((record) => ResourceSchema.parse(record))
    .filter(reviewedCurrent)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const currentIds = new Set(currentResources.map((record) => record.id));
  const currentRelationships = relationships
    .filter((record) => record.schema === "hunch.resource-relationship/1")
    .map((record) => EdgeSchema.parse(record))
    .filter((record) => reviewedCurrent(record) && currentIds.has(record.from) && currentIds.has(record.to))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const targetTokens = tokens(target);
  const scores = new Map<string, { score: number; reason: LandscapeSelectionReason }>();
  for (const resource of currentResources) {
    const match = relevance(resource, target, targetTokens);
    if (match) scores.set(resource.id, match);
  }

  // A matched/root node brings only its immediate reviewed neighbors into the
  // candidate pool. This is orientation, not an unbounded organization crawl.
  const initialIds = new Set(scores.keys());
  for (const relationship of currentRelationships) {
    const fromSelected = initialIds.has(relationship.from);
    const toSelected = initialIds.has(relationship.to);
    if (fromSelected === toSelected) continue;
    const neighborId = fromSelected ? relationship.to : relationship.from;
    const existing = scores.get(neighborId);
    if (!existing || existing.score < 350) scores.set(neighborId, { score: 350, reason: "graph-neighbor" });
  }

  const rankedResources = currentResources
    .filter((record) => scores.has(record.id))
    .sort((left, right) => {
      const leftScore = scores.get(left.id)!.score;
      const rightScore = scores.get(right.id)!.score;
      return rightScore - leftScore || compareCodeUnits(left.id, right.id);
    });
  // Reserve room for connections whenever the selected graph has any. Five
  // nodes + three relationships is the default eight-headline orientation cap.
  const resourceCap = Math.min(rankedResources.length, Math.max(1, Math.ceil(boundedItems * 0.625)));
  const initiallyChosen = rankedResources.slice(0, resourceCap);
  const orientationRoot = rankedResources.find((record) => record.kind === "repository" && record.scope.length === 0);
  const chosenResources = orientationRoot && !initiallyChosen.some((record) => record.id === orientationRoot.id)
    ? [...initiallyChosen.slice(0, Math.max(0, resourceCap - 1)), orientationRoot]
      .sort((left, right) => rankedResources.indexOf(left) - rankedResources.indexOf(right))
    : initiallyChosen;
  const chosenIds = new Set(chosenResources.map((record) => record.id));
  const connectable = currentRelationships.filter((record) => chosenIds.has(record.from) && chosenIds.has(record.to));
  const relationshipCap = Math.max(0, boundedItems - chosenResources.length);
  const chosenRelationships = connectable.slice(0, relationshipCap);
  const omitted: LandscapeSelectionOmission[] = [];
  for (const record of rankedResources.filter((candidate) => !chosenIds.has(candidate.id))) {
    if (omitted.length >= MAX_FRAGMENT_OMISSIONS) break;
    omitted.push({
      kind: "resources",
      recordId: record.id,
      reason: "landscape-cap",
      detail: `reviewed resource fell below the bounded ${boundedItems}-item landscape orientation cap`,
    });
  }
  for (const record of connectable.slice(relationshipCap)) {
    if (omitted.length >= MAX_FRAGMENT_OMISSIONS) break;
    omitted.push({
      kind: "relationships",
      recordId: record.id,
      reason: "landscape-cap",
      detail: `reviewed relationship fell below the bounded ${boundedItems}-item landscape orientation cap`,
    });
  }

  return {
    schema: LANDSCAPE_FRAGMENT_SCHEMA_VERSION,
    authority: "human_confirmed",
    target,
    resources: chosenResources.map((record, index) => ({
      record,
      selectionReason: scores.get(record.id)!.reason,
      selectionRank: index + 1,
    })),
    relationships: chosenRelationships.map((record, index) => ({
      record,
      selectionReason: "graph-connection",
      selectionRank: chosenResources.length + index + 1,
    })),
    omitted,
  };
}

function stringsFromMetadata(
  records: Array<Resource | Edge>,
  key: "landscape_review_id" | "landscape_discovery_hash",
): string[] {
  return [...new Set(records
    .map((record) => record.metadata[key])
    .filter((value): value is string => typeof value === "string"))]
    .sort(compareCodeUnits);
}

export function createLandscapeDeliveryFragment(input: {
  selection: ReviewedLandscapeSelection;
  resources: DeliveredLandscapeResource[];
  relationships: DeliveredLandscapeRelationship[];
  omitted: LandscapeFragmentOmission[];
}): LandscapeDeliveryFragment {
  const deliveredRecords: Array<Resource | Edge> = [
    ...input.resources.map((item) => item.record),
    ...input.relationships.map((item) => item.record),
  ];
  const unsigned = {
    schema: LANDSCAPE_FRAGMENT_SCHEMA_VERSION,
    authority: "human_confirmed" as const,
    target: input.selection.target,
    resources: input.resources,
    relationships: input.relationships,
    omitted: [...input.omitted].sort((left, right) =>
      compareCodeUnits(left.recordId, right.recordId) || compareCodeUnits(left.reason, right.reason)),
    reviewIds: stringsFromMetadata(deliveredRecords, "landscape_review_id"),
    discoveryHashes: stringsFromMetadata(deliveredRecords, "landscape_discovery_hash"),
    sourceRevisions: [...new Set(deliveredRecords
      .map((record) => record.currentness?.source_revision)
      .filter((value): value is string => typeof value === "string"))]
      .sort(compareCodeUnits),
  };
  const fragment = { ...unsigned, fragmentHash: landscapeFragmentHash(unsigned) };
  assertLandscapeDeliveryFragment(fragment);
  return fragment;
}

export function assertLandscapeDeliveryFragment(value: LandscapeDeliveryFragment): void {
  if (value.schema !== LANDSCAPE_FRAGMENT_SCHEMA_VERSION || value.authority !== "human_confirmed") {
    throw new Error("landscape delivery fragment schema or authority is invalid");
  }
  if (!value.target || value.target.length > 100_000) throw new Error("landscape delivery target is invalid");
  if (value.resources.length + value.relationships.length > MAX_FRAGMENT_ITEMS) {
    throw new Error("landscape delivery fragment exceeds its item cap");
  }
  const resourceIds = new Set<string>();
  const ranks = new Set<number>();
  const selectionRanks = new Set<number>();
  for (const item of value.resources) {
    ResourceSchema.parse(item.record);
    if (!reviewedCurrent(item.record)) {
      throw new Error("landscape delivery contains a non-reviewed resource");
    }
    if (resourceIds.has(item.record.id)) throw new Error("landscape delivery resource is duplicated");
    resourceIds.add(item.record.id);
    if (!Number.isSafeInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) throw new Error("landscape delivery rank is invalid");
    ranks.add(item.rank);
    if (!Number.isSafeInteger(item.selectionRank) || item.selectionRank < 1 || selectionRanks.has(item.selectionRank)
      || !["exact-target", "task-match", "orientation-root", "graph-neighbor"].includes(item.selectionReason)) {
      throw new Error("landscape delivery resource selection receipt is invalid");
    }
    selectionRanks.add(item.selectionRank);
    if (item.deliveryReason !== "ranked" || item.required !== false || item.blocking !== false
      || item.provenanceStatus !== "current" || !Number.isSafeInteger(item.tokenCost) || item.tokenCost < 1) {
      throw new Error("landscape delivery resource receipt is invalid");
    }
  }
  const relationshipIds = new Set<string>();
  for (const item of value.relationships) {
    EdgeSchema.parse(item.record);
    if (!reviewedCurrent(item.record) || !resourceIds.has(item.record.from) || !resourceIds.has(item.record.to)) {
      throw new Error("landscape delivery relationship lacks reviewed delivered endpoints");
    }
    if (relationshipIds.has(item.record.id)) throw new Error("landscape delivery relationship is duplicated");
    relationshipIds.add(item.record.id);
    if (!Number.isSafeInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) throw new Error("landscape delivery rank is invalid");
    ranks.add(item.rank);
    if (!Number.isSafeInteger(item.selectionRank) || item.selectionRank < 1 || selectionRanks.has(item.selectionRank)
      || item.selectionReason !== "graph-connection") {
      throw new Error("landscape delivery relationship selection receipt is invalid");
    }
    selectionRanks.add(item.selectionRank);
    if (item.deliveryReason !== "ranked" || item.required !== false || item.blocking !== false
      || item.provenanceStatus !== "current" || !Number.isSafeInteger(item.tokenCost) || item.tokenCost < 1) {
      throw new Error("landscape delivery relationship receipt is invalid");
    }
  }
  if (value.omitted.length > MAX_FRAGMENT_OMISSIONS + MAX_FRAGMENT_ITEMS) {
    throw new Error("landscape delivery omission evidence is unbounded");
  }
  const omissionKeys = new Set<string>();
  for (const item of value.omitted) {
    const key = `${item.kind}:${item.recordId}:${item.reason}`;
    if (!item.recordId || !item.detail || omissionKeys.has(key)
      || !["budget", "stale-provenance", "endpoint-not-delivered", "landscape-cap"].includes(item.reason)) {
      throw new Error("landscape delivery omission receipt is invalid");
    }
    omissionKeys.add(key);
  }
  for (const reviewId of value.reviewIds) if (!REVIEW_ID.test(reviewId)) throw new Error("landscape delivery review id is invalid");
  for (const discoveryHash of value.discoveryHashes) if (!SHA256.test(discoveryHash)) throw new Error("landscape delivery discovery hash is invalid");
  for (const revision of value.sourceRevisions) if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("landscape delivery revision is invalid");
  const deliveredRecords: Array<Resource | Edge> = [
    ...value.resources.map((item) => item.record),
    ...value.relationships.map((item) => item.record),
  ];
  const expectedReviewIds = stringsFromMetadata(deliveredRecords, "landscape_review_id");
  const expectedDiscoveryHashes = stringsFromMetadata(deliveredRecords, "landscape_discovery_hash");
  const expectedSourceRevisions = [...new Set(deliveredRecords
    .map((record) => record.currentness?.source_revision)
    .filter((revision): revision is string => typeof revision === "string"))]
    .sort(compareCodeUnits);
  if (canonical(value.reviewIds) !== canonical(expectedReviewIds)
    || canonical(value.discoveryHashes) !== canonical(expectedDiscoveryHashes)
    || canonical(value.sourceRevisions) !== canonical(expectedSourceRevisions)) {
    throw new Error("landscape delivery evidence summary does not match its delivered records");
  }
  const { fragmentHash, ...unsigned } = value;
  if (!SHA256.test(fragmentHash) || fragmentHash !== landscapeFragmentHash(unsigned)) {
    throw new Error("landscape delivery fragment failed its content hash");
  }
}
