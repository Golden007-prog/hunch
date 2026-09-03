import { createHash } from "node:crypto";
import { z } from "zod";
import { compareCodeUnits } from "./canonicalOrder.js";

export const CHANGE_PROOF_SCHEMA_VERSION = "hunch.change-proof/1" as const;
export const CHANGE_PROOF_ALGORITHM = "hunch-change-proof-sha256/1" as const;

export const CHANGE_PROOF_VERDICTS = ["fail", "pass", "unknown"] as const;
export const CHANGE_PROOF_RELEVANCE = ["blast_radius", "changed_path", "conformance", "guard"] as const;

const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SHA1 = /^sha1:[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CHANGE_ID = /^hchg_[a-f0-9]{24}$/;
const PROOF_ID = /^hproof_[a-f0-9]{24}$/;
const PROFILE_ID = /^pdna_[a-f0-9]{24}$/;
const REPOSITORY_ID = /^pdnar_[a-f0-9]{24}$/;

const RepoPathSchema = z.string().min(1).max(4_096).refine((path) => {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}, "repository path must be canonical and relative");

const HashGapSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
  count: z.number().int().positive().max(1_000_000),
  evidence_hash: z.string().regex(SHA256),
}).strict();

const ChangeIdentitySchema = z.object({
  schema: z.literal("hunch.change-identity/1"),
  algorithm: z.literal("git-raw-tree-delta-sha256/1"),
  change_id: z.string().regex(CHANGE_ID),
  base_revision: z.string().regex(GIT_OBJECT),
  head_revision: z.string().regex(GIT_OBJECT),
  base_tree: z.string().regex(GIT_OBJECT),
  head_tree: z.string().regex(GIT_OBJECT),
  delta_hash: z.string().regex(SHA256),
  patch_id: z.string().regex(GIT_OBJECT).nullable(),
  file_count: z.number().int().positive().max(16_384),
  paths_hash: z.string().regex(SHA256),
  content_hash: z.string().regex(SHA256),
}).strict();

const GraphSealSchema = z.object({
  source: z.literal("commit"),
  revision: z.string().regex(GIT_OBJECT),
  source_hash: z.string().regex(SHA1),
  topology_hash: z.string().regex(SHA256),
  files: z.number().int().nonnegative().max(1_000_000),
  symbols: z.number().int().nonnegative().max(10_000_000),
  edges: z.number().int().nonnegative().max(50_000_000),
  components: z.number().int().nonnegative().max(1_000_000),
  issue_count: z.number().int().nonnegative().max(1_000_000),
}).strict();

const BlastEntrySchema = z.object({
  source_path: RepoPathSchema,
  dependent_path: RepoPathSchema,
  depth: z.number().int().min(1).max(4),
  graphs: z.array(z.enum(["base", "result"])).min(1).max(2),
}).strict();

const DecisionRefSchema = z.object({
  id: z.string().regex(/^dec_[A-Za-z0-9_.-]{3,}$/),
  record_hash: z.string().regex(SHA256),
  relevance: z.array(z.enum(CHANGE_PROOF_RELEVANCE)).min(1).max(4),
  paths: z.array(RepoPathSchema).max(128),
  path_count: z.number().int().nonnegative().max(1_000_000),
  paths_hash: z.string().regex(SHA256),
}).strict();

const ConstraintRefSchema = z.object({
  id: z.string().regex(/^con_[A-Za-z0-9_.-]{3,}$/),
  record_hash: z.string().regex(SHA256),
  severity: z.enum(["advisory", "warning", "blocking"]),
  relevance: z.array(z.enum(["blast_radius", "changed_path"])).min(1).max(2),
  paths: z.array(RepoPathSchema).max(128),
  path_count: z.number().int().nonnegative().max(1_000_000),
  paths_hash: z.string().regex(SHA256),
}).strict();

const ConformanceReceiptSchema = z.object({
  decision_id: z.string().regex(/^dec_[A-Za-z0-9_.-]{3,}$/),
  predicate_index: z.number().int().nonnegative().max(1_000_000),
  predicate_hash: z.string().regex(SHA256),
  satisfied: z.boolean(),
  detail_hash: z.string().regex(SHA256),
}).strict();

export const ChangeProofSchema = z.object({
  schema: z.literal(CHANGE_PROOF_SCHEMA_VERSION),
  algorithm: z.literal(CHANGE_PROOF_ALGORITHM),
  proof_id: z.string().regex(PROOF_ID),
  engine: z.object({
    package: z.literal("@davesheffer/hunch"),
    version: z.string().min(1).max(64),
  }).strict(),
  repository: z.object({
    repository_id: z.string().regex(REPOSITORY_ID),
    base_revision: z.string().regex(GIT_OBJECT),
    result_revision: z.string().regex(GIT_OBJECT),
  }).strict(),
  change: ChangeIdentitySchema,
  project_dna: z.object({
    schema: z.literal("hunch.project-dna/1"),
    profile_id: z.string().regex(PROFILE_ID),
    repository_id: z.string().regex(REPOSITORY_ID),
    repository_revision: z.string().regex(GIT_OBJECT),
    content_hash: z.string().regex(SHA256),
    trait_ids: z.array(z.string().regex(/^pdnat_[a-f0-9]{20}$/)).max(64),
  }).strict(),
  graph: z.object({
    base: GraphSealSchema,
    result: GraphSealSchema,
  }).strict(),
  changed_files: z.array(RepoPathSchema).max(2_048),
  changed_file_count: z.number().int().positive().max(16_384),
  blast_radius: z.array(BlastEntrySchema).max(4_096),
  blast_radius_count: z.number().int().nonnegative().max(10_000_000),
  decisions: z.array(DecisionRefSchema).max(1_024),
  decision_count: z.number().int().nonnegative().max(1_000_000),
  constraints: z.array(ConstraintRefSchema).max(1_024),
  constraint_count: z.number().int().nonnegative().max(1_000_000),
  conformance: z.array(ConformanceReceiptSchema).max(1_024),
  conformance_count: z.number().int().nonnegative().max(1_000_000),
  guard: z.object({
    verdict: z.enum(["pass", "fail"]),
    strict_blocker_ids: z.array(z.string().min(1).max(256)).max(2_048),
    regression_decision_ids: z.array(z.string().regex(/^dec_[A-Za-z0-9_.-]{3,}$/)).max(1_024),
    veto_decision_ids: z.array(z.string().regex(/^dec_[A-Za-z0-9_.-]{3,}$/)).max(1_024),
    report_hash: z.string().regex(SHA256),
  }).strict(),
  memory: z.object({
    scope: z.enum(["public", "union"]),
    records_hash: z.string().regex(SHA256),
  }).strict(),
  omissions: z.array(HashGapSchema).max(64),
  unknowns: z.array(HashGapSchema).max(64),
  verdict: z.enum(CHANGE_PROOF_VERDICTS),
  authority: z.object({
    execution: z.literal(false),
    ci: z.literal(false),
    deployment: z.literal(false),
    merge: z.literal(false),
    ranking: z.literal(false),
    promotion: z.literal(false),
    policy: z.literal(false),
  }).strict(),
  content_hash: z.string().regex(SHA256),
}).strict();

export type ChangeProof = z.infer<typeof ChangeProofSchema>;
export type ChangeProofUnsigned = Omit<ChangeProof, "proof_id" | "content_hash">;

export function canonicalChangeProofJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalChangeProofJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalChangeProofJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function changeProofHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalChangeProofJson(value)).digest("hex")}`;
}

function canonicalArray(values: unknown[]): boolean {
  const rendered = values.map(canonicalChangeProofJson);
  return rendered.every((value, index) => index === 0 || compareCodeUnits(rendered[index - 1]!, value) < 0);
}

function expectedChangeId(change: ChangeProof["change"]): string {
  return `hchg_${changeProofHash({ algorithm: change.algorithm, delta_hash: change.delta_hash })
    .slice("sha256:".length, "sha256:".length + 24)}`;
}

export function sealChangeProof(unsigned: ChangeProofUnsigned): ChangeProof {
  const proofId = `hproof_${changeProofHash(unsigned).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, proof_id: proofId };
  const proof = { ...sealed, content_hash: changeProofHash(sealed) } as ChangeProof;
  assertChangeProof(proof);
  return proof;
}

export function assertChangeProof(value: unknown): asserts value is ChangeProof {
  const proof = ChangeProofSchema.parse(value);
  const sortedArrays: unknown[][] = [
    proof.changed_files,
    proof.blast_radius,
    proof.decisions,
    proof.constraints,
    proof.conformance,
    proof.guard.strict_blocker_ids,
    proof.guard.regression_decision_ids,
    proof.guard.veto_decision_ids,
    proof.omissions,
    proof.unknowns,
    proof.project_dna.trait_ids,
  ];
  if (sortedArrays.some((items) => !canonicalArray(items))) throw new Error("change proof collections must be unique and canonically ordered");
  for (const decision of proof.decisions) {
    if (!canonicalArray(decision.relevance) || !canonicalArray(decision.paths)
      || decision.path_count < decision.paths.length
      || (decision.path_count === decision.paths.length && decision.paths_hash !== changeProofHash(decision.paths))) {
      throw new Error("change proof decision reference is non-canonical");
    }
  }
  for (const constraint of proof.constraints) {
    if (!canonicalArray(constraint.relevance) || !canonicalArray(constraint.paths)
      || constraint.path_count < constraint.paths.length
      || (constraint.path_count === constraint.paths.length && constraint.paths_hash !== changeProofHash(constraint.paths))) {
      throw new Error("change proof constraint reference is non-canonical");
    }
  }
  for (const blast of proof.blast_radius) {
    if (!canonicalArray(blast.graphs) || blast.source_path === blast.dependent_path) {
      throw new Error("change proof blast radius is non-canonical");
    }
  }
  const conformanceKeys = new Set<string>();
  for (const receipt of proof.conformance) {
    const key = `${receipt.decision_id}\0${receipt.predicate_index}`;
    if (conformanceKeys.has(key)) throw new Error("change proof conformance predicate identity is duplicated");
    conformanceKeys.add(key);
  }
  const changeUnsigned = (({ content_hash: _contentHash, ...rest }) => rest)(proof.change);
  if (proof.change.change_id !== expectedChangeId(proof.change)
    || proof.change.content_hash !== changeProofHash(changeUnsigned)) {
    throw new Error("change proof change identity seal is invalid");
  }
  if (proof.repository.base_revision !== proof.change.base_revision
    || proof.repository.result_revision !== proof.change.head_revision
    || proof.project_dna.repository_id !== proof.repository.repository_id
    || proof.project_dna.repository_revision !== proof.repository.result_revision
    || proof.graph.base.revision !== proof.repository.base_revision
    || proof.graph.result.revision !== proof.repository.result_revision
    || proof.changed_file_count !== proof.change.file_count
    || proof.changed_file_count < proof.changed_files.length
    || proof.blast_radius_count < proof.blast_radius.length
    || proof.decision_count < proof.decisions.length
    || proof.constraint_count < proof.constraints.length
    || proof.conformance_count < proof.conformance.length) {
    throw new Error("change proof exact-revision or count binding is invalid");
  }
  const recordsHash = changeProofHash({ decisions: proof.decisions, constraints: proof.constraints });
  if (proof.memory.records_hash !== recordsHash) throw new Error("change proof memory seal is invalid");
  const guardFails = proof.guard.strict_blocker_ids.length > 0;
  if (proof.guard.verdict !== (guardFails ? "fail" : "pass")) throw new Error("change proof guard verdict is invalid");
  const expectedVerdict = guardFails || proof.conformance.some((receipt) => !receipt.satisfied)
    ? "fail"
    : proof.omissions.length || proof.unknowns.length
      ? "unknown"
      : "pass";
  if (proof.verdict !== expectedVerdict) throw new Error("change proof verdict is invalid");
  const { proof_id: _proofId, content_hash: _proofHash, ...unsigned } = proof;
  const expectedProofId = `hproof_${changeProofHash(unsigned).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, proof_id: proof.proof_id };
  if (proof.proof_id !== expectedProofId || proof.content_hash !== changeProofHash(sealed)) {
    throw new Error("change proof seal is invalid");
  }
}
