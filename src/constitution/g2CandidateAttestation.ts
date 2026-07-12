import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import {
  g2CandidateItemHash,
  g2CandidateReviewContentHash,
  type G2CandidateHumanDisposition,
  type G2CandidateReviewReport,
  type G2CandidateReviewResolution,
} from "./g2Candidates.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const HUMAN_ACTOR = /^(human|github|git):[^\s]+$/i;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const G2CandidateDispositionSchema = z.enum(["selected", "rejected"]);

export const G2CandidateAttestationSchema = z.object({
  id: z.string().regex(/^g2attest_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  candidate_id: z.string().regex(/^g2candidate_[a-f0-9]{10}$/),
  candidate_hash: z.string().regex(HASH),
  structural_candidate_id: z.string().regex(/^cand_[a-f0-9]{10}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  review_hash: z.string().regex(HASH),
  disposition: G2CandidateDispositionSchema,
  actor: z.string().regex(HUMAN_ACTOR, "candidate attestation requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^g2attest_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effects: z.literal("review_only"),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export type G2CandidateAttestation = z.infer<typeof G2CandidateAttestationSchema>;

export function g2CandidateAttestationContentHash(attestation: G2CandidateAttestation): string {
  const { id: _id, content_hash: _contentHash, ...body } = attestation;
  return canonicalHash(body);
}

export function compileG2CandidateAttestation(
  report: G2CandidateReviewReport,
  candidateId: string,
  reviewHash: string,
  disposition: G2CandidateHumanDisposition,
  actor: string,
  reason: string,
  opts: { now?: string; supersedes?: string | null } = {},
): G2CandidateAttestation {
  if (report.content_hash !== g2CandidateReviewContentHash(report) || report.id !== `g2candidates_${shortHash(report.content_hash)}`) {
    throw new Error(`G2 candidate review ${report.id} content hash mismatch`);
  }
  if (reviewHash !== report.content_hash) throw new Error("candidate review hash does not match the exact current review packet");
  const candidate = report.items.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`candidate ${candidateId} is not present in review ${report.id}`);
  const body = {
    candidate_id: candidate.id,
    candidate_hash: g2CandidateItemHash(candidate),
    structural_candidate_id: candidate.candidate_id,
    commit: candidate.commit,
    review_hash: report.content_hash,
    disposition: G2CandidateDispositionSchema.parse(disposition),
    actor,
    reason: reason.trim(),
    supersedes: opts.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "review_only" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return G2CandidateAttestationSchema.parse({
    id: `g2attest_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}

/** Resolve exact-candidate supersession chains without timestamp trust. */
export function currentG2CandidateAttestations(records: G2CandidateAttestation[]): G2CandidateAttestation[] {
  const parsed = records.map((record) => G2CandidateAttestationSchema.parse(record));
  const byId = new Map(parsed.map((record) => [record.id, record]));
  if (byId.size !== parsed.length) throw new Error("duplicate G2 candidate attestation id");
  const identity = (record: G2CandidateAttestation): string => `${record.candidate_id}:${record.candidate_hash}`;
  const childCount = new Map<string, number>();
  for (const record of parsed) {
    if (!record.supersedes) continue;
    const parent = byId.get(record.supersedes);
    if (!parent) throw new Error(`G2 candidate attestation ${record.id} supersedes missing ${record.supersedes}`);
    if (identity(parent) !== identity(record)
      || parent.structural_candidate_id !== record.structural_candidate_id
      || parent.commit !== record.commit) {
      throw new Error(`G2 candidate attestation ${record.id} supersedes a different exact candidate`);
    }
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
    if (childCount.get(parent.id)! > 1) throw new Error(`G2 candidate attestation ${parent.id} has a branched supersession chain`);
  }
  for (const record of parsed) {
    const visited = new Set<string>();
    let cursor: G2CandidateAttestation | undefined = record;
    while (cursor?.supersedes) {
      if (visited.has(cursor.id)) throw new Error(`G2 candidate attestation chain contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  const current = parsed.filter((record) => !childCount.has(record.id));
  const currentTargets = new Set<string>();
  for (const record of current) {
    const key = identity(record);
    if (currentTargets.has(key)) throw new Error(`G2 candidate ${key} has multiple current attestations`);
    currentTargets.add(key);
  }
  return current.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id) || left.id.localeCompare(right.id));
}

export class G2CandidateAttestationRepository {
  constructor(private readonly store: HunchStore) {}

  list(): G2CandidateAttestation[] {
    const dir = this.store.privateDir ? join(this.store.privateDir, "candidate-attestations") : undefined;
    if (!dir || !existsSync(dir)) return [];
    const records = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        try {
          if (!/^g2attest_[a-f0-9]{10}\.json$/.test(name)) throw new Error("unexpected attestation filename");
          const parsed = G2CandidateAttestationSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
          if (parsed.content_hash !== g2CandidateAttestationContentHash(parsed)
            || parsed.id !== `g2attest_${shortHash(parsed.content_hash)}`) {
            throw new Error(`G2 candidate attestation ${parsed.id} content hash mismatch`);
          }
          if (name !== `${parsed.id}.json`) throw new Error(`filename does not match attestation ${parsed.id}`);
          return parsed;
        } catch (error) {
          throw new Error(`invalid candidate-attestations/${name}: ${(error as Error).message}`);
        }
      });
    currentG2CandidateAttestations(records);
    return records;
  }

  current(): G2CandidateAttestation[] {
    return currentG2CandidateAttestations(this.list());
  }

  resolutions(): G2CandidateReviewResolution[] {
    return this.current().map((record) => ({
      id: record.id,
      candidate_id: record.candidate_id,
      candidate_hash: record.candidate_hash,
      review_hash: record.review_hash,
      disposition: record.disposition,
      actor: record.actor,
      reason: record.reason,
      created_at: record.created_at,
    }));
  }

  put(attestation: G2CandidateAttestation): G2CandidateAttestation {
    if (!this.store.privateDir) throw new Error("No private Hunch overlay is configured; refusing to write G2 candidate attestation.");
    const parsed = G2CandidateAttestationSchema.parse(attestation);
    if (parsed.content_hash !== g2CandidateAttestationContentHash(parsed)
      || parsed.id !== `g2attest_${shortHash(parsed.content_hash)}`) {
      throw new Error(`G2 candidate attestation ${parsed.id} content hash mismatch`);
    }
    const records = this.list();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentG2CandidateAttestations(records).find((record) => (
      record.candidate_id === parsed.candidate_id && record.candidate_hash === parsed.candidate_hash
    ));
    if (current && parsed.supersedes !== current.id) {
      throw new Error(`G2 candidate attestation ${current.id} is current; pass supersedes:${current.id} to append a correction`);
    }
    if (!current && parsed.supersedes) throw new Error(`G2 candidate attestation ${parsed.id} supersedes no current exact candidate review`);
    currentG2CandidateAttestations([...records, parsed]);
    const dir = join(this.store.privateDir, "candidate-attestations");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}
