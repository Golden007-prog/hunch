import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { shortHash } from "../core/ids.js";
import { writeFileAtomic } from "../core/io.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import {
  g2BehaviorCandidateHash,
  g2BehaviorReplayContentHash,
  g2BehaviorReviewContentHash,
  type G2BehaviorCandidateReview,
  type G2BehaviorHumanDisposition,
  type G2BehaviorReplayReceipt,
  type G2BehaviorReviewResolution,
} from "./g2BehaviorCandidates.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const HUMAN_ACTOR = /^(human|github|git):[^\s]+$/i;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const G2BehaviorDispositionSchema = z.enum(["selected", "rejected"]);

export const G2BehaviorAttestationSchema = z.object({
  id: z.string().regex(/^g2behaviorattest_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
  candidate_hash: z.string().regex(HASH),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  review_hash: z.string().regex(HASH),
  replay_id: z.string().regex(/^g2behaviorreplay_[a-f0-9]{10}$/),
  replay_hash: z.string().regex(HASH),
  dependency_snapshot_ids: z.array(z.string().regex(/^g2deps_[a-f0-9]{10}$/)).min(1).max(2),
  disposition: G2BehaviorDispositionSchema,
  actor: z.string().regex(HUMAN_ACTOR, "behavior attestation requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^g2behaviorattest_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effects: z.literal("review_only"),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export type G2BehaviorAttestation = z.infer<typeof G2BehaviorAttestationSchema>;

export function g2BehaviorAttestationContentHash(attestation: G2BehaviorAttestation): string {
  const { id: _id, content_hash: _contentHash, ...body } = attestation;
  return canonicalHash(body);
}

export function compileG2BehaviorAttestation(
  report: G2BehaviorCandidateReview,
  candidateId: string,
  reviewHash: string,
  replay: G2BehaviorReplayReceipt,
  disposition: G2BehaviorHumanDisposition,
  actor: string,
  reason: string,
  opts: { now?: string; supersedes?: string | null } = {},
): G2BehaviorAttestation {
  if (report.content_hash !== g2BehaviorReviewContentHash(report)
    || report.id !== `g2behaviorcandidates_${shortHash(report.content_hash)}`) {
    throw new Error(`G2 behavior candidate review ${report.id} content hash mismatch`);
  }
  if (reviewHash !== report.content_hash) throw new Error("behavior candidate review hash does not match the exact current review packet");
  const candidate = report.items.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`behavior candidate ${candidateId} is not present in review ${report.id}`);
  if (replay.content_hash !== g2BehaviorReplayContentHash(replay)
    || replay.id !== `g2behaviorreplay_${shortHash(replay.content_hash)}`) {
    throw new Error(`G2 behavior replay ${replay.id} content hash mismatch`);
  }
  const candidateHash = g2BehaviorCandidateHash(candidate);
  if (replay.candidate_id !== candidate.id
    || replay.candidate_hash !== candidateHash
    || replay.review_hash !== report.content_hash) {
    throw new Error(`G2 behavior replay ${replay.id} does not bind the exact reviewed candidate`);
  }
  const parsedDisposition = G2BehaviorDispositionSchema.parse(disposition);
  const dependencySnapshotIds = [...new Set([
    replay.known_bad.dependency_snapshot_id,
    replay.known_good.dependency_snapshot_id,
  ].filter((id): id is string => !!id))].sort();
  if (parsedDisposition === "selected"
    && (replay.verdict !== "behavior_confirmed"
      || replay.known_bad.result !== "failed"
      || replay.known_good.result !== "passed"
      || !replay.known_bad.dependency_snapshot_id
      || !replay.known_good.dependency_snapshot_id)) {
    throw new Error("selecting a behavior candidate requires an exact snapshot-backed behavior_confirmed replay");
  }
  if (!dependencySnapshotIds.length) throw new Error("behavior attestation requires at least one exact dependency snapshot");
  const body = {
    candidate_id: candidate.id,
    candidate_hash: candidateHash,
    commit: candidate.commit,
    review_hash: report.content_hash,
    replay_id: replay.id,
    replay_hash: replay.content_hash,
    dependency_snapshot_ids: dependencySnapshotIds,
    disposition: parsedDisposition,
    actor,
    reason: reason.trim(),
    supersedes: opts.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "review_only" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return G2BehaviorAttestationSchema.parse({
    id: `g2behaviorattest_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}

/** Resolve exact-behavior supersession chains without timestamp trust. */
export function currentG2BehaviorAttestations(records: G2BehaviorAttestation[]): G2BehaviorAttestation[] {
  const parsed = records.map((record) => G2BehaviorAttestationSchema.parse(record));
  const byId = new Map(parsed.map((record) => [record.id, record]));
  if (byId.size !== parsed.length) throw new Error("duplicate G2 behavior attestation id");
  const identity = (record: G2BehaviorAttestation): string => `${record.candidate_id}:${record.candidate_hash}`;
  const childCount = new Map<string, number>();
  for (const record of parsed) {
    if (!record.supersedes) continue;
    const parent = byId.get(record.supersedes);
    if (!parent) throw new Error(`G2 behavior attestation ${record.id} supersedes missing ${record.supersedes}`);
    if (identity(parent) !== identity(record) || parent.commit !== record.commit) {
      throw new Error(`G2 behavior attestation ${record.id} supersedes a different exact candidate`);
    }
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
    if (childCount.get(parent.id)! > 1) throw new Error(`G2 behavior attestation ${parent.id} has a branched supersession chain`);
  }
  for (const record of parsed) {
    const visited = new Set<string>();
    let cursor: G2BehaviorAttestation | undefined = record;
    while (cursor?.supersedes) {
      if (visited.has(cursor.id)) throw new Error(`G2 behavior attestation chain contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  const current = parsed.filter((record) => !childCount.has(record.id));
  const targets = new Set<string>();
  for (const record of current) {
    const key = identity(record);
    if (targets.has(key)) throw new Error(`G2 behavior candidate ${key} has multiple current attestations`);
    targets.add(key);
  }
  return current.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id) || left.id.localeCompare(right.id));
}

export class G2BehaviorAttestationRepository {
  constructor(private readonly store: HunchStore) {}

  list(): G2BehaviorAttestation[] {
    const dir = this.store.privateDir ? join(this.store.privateDir, "behavior-attestations") : undefined;
    if (!dir || !existsSync(dir)) return [];
    const records = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        try {
          if (!/^g2behaviorattest_[a-f0-9]{10}\.json$/.test(name)) throw new Error("unexpected attestation filename");
          const parsed = G2BehaviorAttestationSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
          if (parsed.content_hash !== g2BehaviorAttestationContentHash(parsed)
            || parsed.id !== `g2behaviorattest_${shortHash(parsed.content_hash)}`) {
            throw new Error(`G2 behavior attestation ${parsed.id} content hash mismatch`);
          }
          if (name !== `${parsed.id}.json`) throw new Error(`filename does not match attestation ${parsed.id}`);
          return parsed;
        } catch (error) {
          throw new Error(`invalid behavior-attestations/${name}: ${(error as Error).message}`);
        }
      });
    currentG2BehaviorAttestations(records);
    return records;
  }

  current(): G2BehaviorAttestation[] {
    return currentG2BehaviorAttestations(this.list());
  }

  resolutions(): G2BehaviorReviewResolution[] {
    return this.current().map((record) => ({
      id: record.id,
      candidate_id: record.candidate_id,
      candidate_hash: record.candidate_hash,
      review_hash: record.review_hash,
      replay_id: record.replay_id,
      replay_hash: record.replay_hash,
      disposition: record.disposition,
      actor: record.actor,
      reason: record.reason,
      created_at: record.created_at,
    }));
  }

  put(attestation: G2BehaviorAttestation): G2BehaviorAttestation {
    if (!this.store.privateDir) throw new Error("No private Hunch overlay is configured; refusing to write G2 behavior attestation.");
    const parsed = G2BehaviorAttestationSchema.parse(attestation);
    if (parsed.content_hash !== g2BehaviorAttestationContentHash(parsed)
      || parsed.id !== `g2behaviorattest_${shortHash(parsed.content_hash)}`) {
      throw new Error(`G2 behavior attestation ${parsed.id} content hash mismatch`);
    }
    const records = this.list();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentG2BehaviorAttestations(records).find((record) => (
      record.candidate_id === parsed.candidate_id && record.candidate_hash === parsed.candidate_hash
    ));
    if (current && parsed.supersedes !== current.id) {
      throw new Error(`G2 behavior attestation ${current.id} is current; pass supersedes:${current.id} to append a correction`);
    }
    if (!current && parsed.supersedes) throw new Error(`G2 behavior attestation ${parsed.id} supersedes no current exact candidate review`);
    currentG2BehaviorAttestations([...records, parsed]);
    const dir = join(this.store.privateDir, "behavior-attestations");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}
