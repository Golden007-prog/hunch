/**
 * Hash-bound human review for live ADRs imported from MADR/Nygard documents.
 *
 * Import gives Hunch useful advisory memory immediately, but importing a file is
 * not a human countersign. This module owns the narrow trust-elevation boundary:
 * an explicit approve/decline answer applies only to the exact source bytes the
 * person saw. Re-importing unchanged bytes preserves the answer; changed bytes
 * discard it and become reviewable again.
 */
import { createHash } from "node:crypto";
import type { Decision } from "./types.js";
import { isCredentialFreeText } from "./types.js";

export type ImportedAdrDisposition = "approve" | "decline";

export interface ImportedAdrReview {
  disposition: ImportedAdrDisposition;
  sourceHash: string;
  reviewHash: string;
  reviewer: string | null;
  reviewedAt: string | null;
}

const SOURCE_HASH = /^sha256:[a-f0-9]{64}$/;
const REVIEW_RECEIPT = /^adr-review:(approved|declined):(sha256:[a-f0-9]{64})$/;
const REVIEW_HASH_PREFIX = "adr-review-candidate:";
const REVIEWER_PREFIX = "adr-reviewer:";
const REVIEWED_AT_PREFIX = "adr-reviewed-at:";

function sourceTokens(source: string): string[] {
  return source.split("+").filter(Boolean);
}

function withoutHumanConfirmation(source: string): string {
  return sourceTokens(source).filter((token) => token !== "human_confirmed").join("+");
}

function withHumanConfirmation(source: string): string {
  const tokens = sourceTokens(source);
  if (!tokens.includes("human_confirmed")) tokens.push("human_confirmed");
  return tokens.join("+");
}

export function isImportedAdrDecision(decision: Decision): boolean {
  return sourceTokens(decision.provenance.source).includes("imported:madr");
}

export function importedAdrSourceHash(decision: Decision): string | null {
  return decision.provenance.evidence.find((item) => SOURCE_HASH.test(item)) ?? null;
}

/** Hash the complete mapped meaning, not just the ADR source bytes. This prevents
 * a later importer/parser change from carrying old authority onto new semantics
 * even when the Markdown file itself did not change. */
export function importedAdrReviewHash(decision: Decision): string {
  const evidence = decision.provenance.evidence.filter((item) =>
    !REVIEW_RECEIPT.test(item)
    && !item.startsWith(REVIEW_HASH_PREFIX)
    && !item.startsWith(REVIEWER_PREFIX)
    && !item.startsWith(REVIEWED_AT_PREFIX));
  const canonical = {
    id: decision.id,
    title: decision.title,
    topic: decision.topic,
    status: decision.status,
    context: decision.context,
    decision: decision.decision,
    consequences: decision.consequences,
    alternatives_rejected: decision.alternatives_rejected,
    rejected_tripwires: decision.rejected_tripwires,
    related_components: decision.related_components,
    related_files: decision.related_files,
    supersedes: decision.supersedes,
    superseded_by: decision.superseded_by,
    caused_by_bug: decision.caused_by_bug,
    commit: decision.commit,
    valid_from: decision.valid_from ?? null,
    valid_to: decision.valid_to,
    retired: decision.retired,
    date: decision.date,
    import_evidence: evidence,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function currentReviewReceipt(decision: Decision): ImportedAdrReview | null {
  const sourceHash = importedAdrSourceHash(decision);
  if (!sourceHash) return null;
  const reviewHash = importedAdrReviewHash(decision);
  const recordedReviewHash = decision.provenance.evidence.find((value) => value.startsWith(REVIEW_HASH_PREFIX))?.slice(REVIEW_HASH_PREFIX.length);
  if (recordedReviewHash !== reviewHash) return null;
  for (const item of decision.provenance.evidence) {
    const match = REVIEW_RECEIPT.exec(item);
    if (!match || match[2] !== sourceHash) continue;
    return {
      disposition: match[1] === "approved" ? "approve" : "decline",
      sourceHash,
      reviewHash,
      reviewer: decision.provenance.evidence.find((value) => value.startsWith(REVIEWER_PREFIX))?.slice(REVIEWER_PREFIX.length) ?? null,
      reviewedAt: decision.provenance.evidence.find((value) => value.startsWith(REVIEWED_AT_PREFIX))?.slice(REVIEWED_AT_PREFIX.length) ?? null,
    };
  }
  return null;
}

export function importedAdrReview(decision: Decision): ImportedAdrReview | null {
  const receipt = currentReviewReceipt(decision);
  if (receipt) return receipt;
  const sourceHash = importedAdrSourceHash(decision);
  if (sourceHash && sourceTokens(decision.provenance.source).includes("human_confirmed")) {
    // Backward-compatible with an imported record countersigned before receipts
    // existed. Its exact source hash still prevents carrying it onto changed bytes.
    return {
      disposition: "approve",
      sourceHash,
      reviewHash: importedAdrReviewHash(decision),
      reviewer: null,
      reviewedAt: decision.provenance.last_verified ?? null,
    };
  }
  return null;
}

export function isPendingImportedAdrReview(decision: Decision): boolean {
  return isImportedAdrDecision(decision)
    && decision.status === "accepted"
    && !decision.superseded_by
    && !decision.valid_to
    && !!importedAdrSourceHash(decision)
    && importedAdrReview(decision) === null;
}

export function pendingImportedAdrReviews(decisions: readonly Decision[]): Decision[] {
  return decisions
    .filter(isPendingImportedAdrReview)
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id));
}

function validateReviewer(reviewer: string): string {
  const normalized = reviewer.trim();
  if (!normalized || normalized.length > 128 || /[\r\n]/.test(normalized) || !isCredentialFreeText(normalized)) {
    throw new Error("ADR reviewer must be a credential-free label of 1-128 characters");
  }
  return normalized;
}

/** Apply one explicit answer to one exact live imported ADR. Never changes the
 * ADR lifecycle or content: decline means "reviewed, keep advisory", not delete. */
export function applyImportedAdrReview(
  decision: Decision,
  input: {
    disposition: ImportedAdrDisposition;
    expectedSourceHash: string;
    expectedReviewHash: string;
    reviewer: string;
    reviewedAt?: string;
  },
): Decision {
  if (!isImportedAdrDecision(decision)) throw new Error(`${decision.id} is not an imported MADR/Nygard decision`);
  if (decision.status !== "accepted" || decision.superseded_by || decision.valid_to) {
    throw new Error(`${decision.id} is no longer a live accepted ADR; refresh the review question`);
  }
  if (!SOURCE_HASH.test(input.expectedSourceHash)) throw new Error("expected ADR source hash must be sha256:<64 lowercase hex characters>");
  const actualHash = importedAdrSourceHash(decision);
  if (!actualHash || actualHash !== input.expectedSourceHash) {
    throw new Error(`ADR source changed after the question was shown (expected ${input.expectedSourceHash}, current ${actualHash ?? "missing"}); review the current ADR instead`);
  }
  if (!SOURCE_HASH.test(input.expectedReviewHash)) throw new Error("expected ADR review hash must be sha256:<64 lowercase hex characters>");
  const actualReviewHash = importedAdrReviewHash(decision);
  if (actualReviewHash !== input.expectedReviewHash) {
    throw new Error(`imported ADR meaning changed after the question was shown (expected ${input.expectedReviewHash}, current ${actualReviewHash}); review the current ADR instead`);
  }
  const reviewer = validateReviewer(input.reviewer);
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (reviewedAt.length > 64 || !Number.isFinite(Date.parse(reviewedAt))) throw new Error("ADR review timestamp must be ISO-compatible");
  const evidence = decision.provenance.evidence.filter((item) =>
    !REVIEW_RECEIPT.test(item) && !item.startsWith(REVIEW_HASH_PREFIX) && !item.startsWith(REVIEWER_PREFIX) && !item.startsWith(REVIEWED_AT_PREFIX));
  evidence.push(
    `adr-review:${input.disposition === "approve" ? "approved" : "declined"}:${actualHash}`,
    `${REVIEW_HASH_PREFIX}${actualReviewHash}`,
    `${REVIEWER_PREFIX}${reviewer}`,
    `${REVIEWED_AT_PREFIX}${reviewedAt}`,
  );
  return {
    ...decision,
    provenance: {
      ...decision.provenance,
      source: input.disposition === "approve"
        ? withHumanConfirmation(decision.provenance.source)
        : withoutHumanConfirmation(decision.provenance.source),
      confidence: input.disposition === "approve" ? Math.max(decision.provenance.confidence, 0.95) : Math.min(decision.provenance.confidence, 0.75),
      evidence,
      last_verified: reviewedAt,
    },
  };
}

/** Carry a review across idempotent re-import only when the source bytes match.
 * A changed hash deliberately returns the clean new import, reopening review. */
export function carryImportedAdrReview(previous: Decision | null | undefined, next: Decision): Decision {
  if (!previous || !isImportedAdrDecision(previous) || !isImportedAdrDecision(next)) return next;
  const previousHash = importedAdrSourceHash(previous);
  const nextHash = importedAdrSourceHash(next);
  if (!previousHash || previousHash !== nextHash) return next;
  const review = importedAdrReview(previous);
  if (!review || review.reviewHash !== importedAdrReviewHash(next)) return next;
  const receiptEvidence = previous.provenance.evidence.filter((item) =>
    REVIEW_RECEIPT.test(item) || item.startsWith(REVIEW_HASH_PREFIX) || item.startsWith(REVIEWER_PREFIX) || item.startsWith(REVIEWED_AT_PREFIX));
  return {
    ...next,
    provenance: {
      ...next.provenance,
      source: review.disposition === "approve"
        ? withHumanConfirmation(next.provenance.source)
        : withoutHumanConfirmation(next.provenance.source),
      confidence: review.disposition === "approve" ? Math.max(next.provenance.confidence, 0.95) : next.provenance.confidence,
      evidence: [...next.provenance.evidence, ...receiptEvidence],
      last_verified: previous.provenance.last_verified,
    },
  };
}
