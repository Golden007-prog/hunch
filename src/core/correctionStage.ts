import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";
import {
  rankIssueImplementationOwners,
  type ContractAxisOwnerSource,
} from "./pipeline.js";
import {
  compileVerifiedEvidenceMap,
  type VerifiedEvidenceMap,
} from "./evidenceMap.js";
import {
  buildFileFirstDeclarationClusters,
  buildProgressiveDeclarationPlan,
  type FileFirstDeclarationDiagnostic,
  type ProgressiveDeclarationPlan,
} from "./declarationClusters.js";

/** The contract-owning layer suggested by issue/reproduction prose. */
export type CorrectionStage =
  | "schema-emission"
  | "schema-ingestion"
  | "presentation"
  | "constraint-definition"
  | "runtime-policy";

export interface CorrectionStageCandidate {
  owner: string;
  stage: CorrectionStage;
  lexical_score: number;
  symbol_overlap: number;
  runtime_declaration: boolean;
  type_scaffolding: boolean;
  default_locale: boolean;
}

export interface AdaptiveCorrectionStageCandidate {
  owner: string;
  stage: CorrectionStage;
  score: number;
  lexical_score: number;
  path_overlap: number;
  symbol_overlap: number;
  component_support: number;
  runtime_declaration: boolean;
  invoked_entrance: boolean;
  generic_entrance: boolean;
  type_scaffolding: boolean;
}

export interface EvidenceGuidedCorrectionStageCandidate extends AdaptiveCorrectionStageCandidate {
  baseline_rank: number;
  optimized_rank: number;
  evidence: {
    behavior_sensitive_owner: boolean;
    behavior_sensitive_file: boolean;
    target_only_execution: boolean;
    shared_execution: boolean;
    strong_differential_file: boolean;
  };
}

export const EVIDENCE_GUIDED_SHORTLIST_RULE = "guarded-evidence-bridge-v3" as const;

export interface CorrectionStageOptimizationReceipt {
  version: 3;
  receipt_id: string;
  rule: typeof EVIDENCE_GUIDED_SHORTLIST_RULE;
  applied: boolean;
  reason:
    | "evidence-reordered"
    | "already-ranked"
    | "claim-mismatch"
    | "probe-unverified"
    | "transfer-rejected-read-only"
    | "no-actionable-evidence"
    | "no-sensitive-declaration-resolved";
  evidence_level: VerifiedEvidenceMap["level"];
  probe_authenticated: boolean;
  claim_bound: boolean;
  requested_limit: number;
  evidence_slots: number;
  evidence_strategy: "behavior-sensitive" | "direct-high-contrast-execution" | "guarded-execution-file-peer" | null;
  selected_execution_ratio: number | null;
  selected_static_rank: number | null;
  baseline_candidates: string[];
  optimized_candidates: string[];
  promoted_candidates: string[];
  displaced_candidates: string[];
  behavior_sensitive_files: string[];
  strong_differential_files: string[];
  exact_owner_enabled: false;
}

export interface CorrectionStageDiagnostic {
  stage: CorrectionStage;
  likely_file: string | null;
  candidates: Array<CorrectionStageCandidate | AdaptiveCorrectionStageCandidate | EvidenceGuidedCorrectionStageCandidate>;
  file_first_declaration_clusters: FileFirstDeclarationDiagnostic;
  progressive_inspection: ProgressiveDeclarationPlan;
  exact_owner_enabled: false;
  optimization: CorrectionStageOptimizationReceipt | null;
  calibration: {
    holdout_tasks: 11;
    likely_file_hits: 9;
    top_five_hits: 8;
  };
  cross_repository_transfer: {
    repositories: readonly ["jquense/yup", "sinclairzx81/typebox"];
    holdout_tasks: 16;
    likely_file_hits: 0;
    top_five_hits: 0;
    decision: "rejected";
  };
  adaptive_transfer: {
    repositories: readonly ["arktypeio/arktype", "typestack/class-validator"];
    scorable_tasks: 11;
    likely_file_hits: 8;
    top_five_hits: 9;
    exact_symbol_hits: 7;
    decision: "promoted-diagnostic";
  };
  adaptive_replication: {
    repositories: readonly ["trpc/trpc", "elysiajs/elysia"];
    scorable_tasks: 11;
    likely_file_hits: 4;
    top_five_hits: 5;
    exact_symbol_hits: 4;
    decision: "failed-replication";
  };
  optimization_policy: typeof CORRECTION_OPTIMIZATION_POLICY;
}

export const CORRECTION_STAGE_CANDIDATE_LIMIT = 5;
export const EVIDENCE_GUIDED_SLOT_LIMIT = 3;
export const EVIDENCE_GUIDED_BASELINE_FLOOR = 2;
export const EXECUTION_GUIDED_SLOT_LIMIT = 1;
export const EXECUTION_GUIDED_BASELINE_FLOOR = 4;
export const EXECUTION_DIRECT_RATIO_MIN = 4;
export const EXECUTION_DIRECT_STATIC_RANK_MAX = 20;
export const EXECUTION_FILE_RATIO_MIN = 2;
export const EXECUTION_FILE_STATIC_RANK_MAX = 10;
const EXECUTION_BRIDGE_INFRASTRUCTURE_PATH = /(?:^|\/)doc\.ts$/;
export const CORRECTION_STAGE_CALIBRATION = {
  holdout_tasks: 11,
  likely_file_hits: 9,
  top_five_hits: 8,
} as const;
export const CORRECTION_STAGE_TRANSFER = {
  repositories: ["jquense/yup", "sinclairzx81/typebox"],
  holdout_tasks: 16,
  likely_file_hits: 0,
  top_five_hits: 0,
  decision: "rejected",
} as const;
export const ADAPTIVE_CORRECTION_STAGE_TRANSFER = {
  repositories: ["arktypeio/arktype", "typestack/class-validator"],
  scorable_tasks: 11,
  likely_file_hits: 8,
  top_five_hits: 9,
  exact_symbol_hits: 7,
  decision: "promoted-diagnostic",
} as const;
export const ADAPTIVE_CORRECTION_STAGE_REPLICATION = {
  repositories: ["trpc/trpc", "elysiajs/elysia"],
  scorable_tasks: 11,
  likely_file_hits: 4,
  top_five_hits: 5,
  exact_symbol_hits: 4,
  decision: "failed-replication",
} as const;
export const CORRECTION_OPTIMIZATION_POLICY = {
  active: [
    { mechanism: "repository-adaptive-ranking", verdict: "promote-adaptive-diagnostic" },
    { mechanism: "flat-file-anchored-semantic-clusters", verdict: "promote-flat-file-anchored-clusters-v3" },
  ],
  advisory_only: [
    { mechanism: "static-stage-shortlist", verdict: "retain-diagnostic-stage-shortlist" },
    { mechanism: "progressive-inspection-budget", verdict: "retain-efficiency-advisory-v4" },
  ],
  disabled: [
    { mechanism: "fixed-repository-stage-router", verdict: "reject-cross-repository-transfer" },
    { mechanism: "score-gap-confidence", verdict: "reject-shortlist-evidence" },
    { mechanism: "cross-view-confidence", verdict: "reject-cross-view-evidence" },
    { mechanism: "causal-slot-owner", verdict: "reject-causal-slot" },
    { mechanism: "causal-intervention-owner", verdict: "reject-causal-intervention-owner" },
    { mechanism: "evidence-guided-reordering", verdict: "reject-guarded-evidence-bridge-v3" },
    { mechanism: "product-source-filter", verdict: "reject-development-v5-one-loss" },
    { mechanism: "one-hop-relationship-expansion", verdict: "reject-development-v5-no-lift" },
    { mechanism: "same-file-frontier-replacement", verdict: "reject-development-v5-three-losses" },
    { mechanism: "additive-same-file-frontier", verdict: "reject-additive-frontier-v5-no-fresh-rescue" },
  ],
  exact_owner_policy: "disabled",
  per_case_confidence: "disabled",
} as const;

function boundedIssue(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100_000) : "";
}

/** Classify the layer that owns the broken contract, not the public API through
 * which the symptom happened to surface. This is deterministic and read-only. */
export function inferIssueCorrectionStage(issueValue: unknown): CorrectionStage {
  const text = boundedIssue(issueValue).toLowerCase();
  if (/fromjsonschema|from json schema|json schema (?:input|import|conversion)/.test(text)) return "schema-ingestion";
  if (/tojsonschema|to json schema|\$ref|\$defs|json pointer|json schema (?:output|emit|serial)/.test(text)) return "schema-emission";
  if (/error message|message (?:uses|says|wording|ignore)|wording|locale|render(?:ing|er)?/.test(text)) return "presentation";
  if (/\borigin\b|\bminimum\b|\bmaximum\b|\binclusive\b|\bexact flag\b|constraint/.test(text)) return "constraint-definition";
  return "runtime-policy";
}

/** Repository paths that commonly implement each correction stage. Exported so
 * safe source collection can prioritize the relevant layer in very large repos. */
export function correctionStagePathPattern(stage: CorrectionStage, issueValue: unknown): RegExp {
  const issue = boundedIssue(issueValue).toLowerCase();
  const referenceAssembly = stage === "schema-emission" && /\$ref|\$defs|json pointer/.test(issue);
  const patterns: Record<CorrectionStage, RegExp> = {
    "schema-emission": referenceAssembly ? /to-json-schema/ : /(?:json-schema-processors|to-json-schema)/,
    "schema-ingestion": /from-json-schema/,
    presentation: /(?:^|\/)(?:locales\/|errors?\.ts$)/,
    "constraint-definition": /(?:^|\/)(?:checks|api)\.ts$/,
    "runtime-policy": /(?:^|\/)(?:schemas|checks|parse)\.ts$/,
  };
  return patterns[stage];
}

function terms(value: string): Set<string> {
  return new Set(value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .map((term) => term.replace(/^[$_]+/, ""))
    .filter((term) => term.length >= 3));
}

/** Approximate top-level runtime declarations without loading TypeScript into
 * every Hunch process. Type-only declarations intentionally remain candidates,
 * but runtime declarations win ties in the selected layer. */
function runtimeDeclarationOwners(sources: ContractAxisOwnerSource[]): Set<string> {
  const owners = new Set<string>();
  for (const source of sources) {
    const declaration = source.path.endsWith(".php")
      ? /^(?:(?:#\[[^\r\n]*\])\r?\n)*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|function)\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)/gm
      : /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|enum|const|let|var)\s+([$A-Za-z_][$\w]*)/gm;
    for (const match of source.content.matchAll(declaration)) {
      owners.add(`${source.path}::${match[1]}`);
    }
  }
  return owners;
}

/** Return a stage-constrained declaration ranking. Public APIs invoked by the
 * reproduction are treated as symptom entrances and excluded whenever deeper
 * candidates exist in the selected stage. */
export function rankIssueCorrectionStageCandidates(
  issueValue: unknown,
  sources: ContractAxisOwnerSource[],
): CorrectionStageCandidate[] {
  const issue = boundedIssue(issueValue);
  if (!issue) return [];
  const stage = inferIssueCorrectionStage(issue);
  const stagePath = correctionStagePathPattern(stage, issue);
  const invoked = new Set([...issue.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
    .map((match) => match[1]!.replace(/^[$_]+/, "").toLowerCase()));
  const issueTerms = terms(issue);
  const runtimeOwners = runtimeDeclarationOwners(sources);
  const lexical = rankIssueImplementationOwners(issue, sources, 4_000)?.candidates ?? [];
  const inStage = lexical.filter((candidate) => stagePath.test(candidate.owner.split("::")[0]!));
  const deeper = inStage.filter((candidate) => !invoked.has(
    (candidate.owner.split("::")[1] ?? "").replace(/^[$_]+/, "").toLowerCase(),
  ));
  const ranked = (deeper.length ? deeper : inStage).map((candidate) => {
    const [path, symbol = ""] = candidate.owner.split("::");
    return {
      owner: candidate.owner,
      stage,
      lexical_score: candidate.score,
      symbol_overlap: [...terms(symbol)].filter((term) => issueTerms.has(term)).length,
      runtime_declaration: runtimeOwners.has(candidate.owner),
      type_scaffolding: /(?:Def|Internals?|Context|Options?|Params?|Input|Output)$/.test(symbol),
      default_locale: stage === "presentation" && path!.endsWith("/locales/en.ts"),
    };
  }).sort((a, b) => Number(b.default_locale) - Number(a.default_locale)
    || Number(b.runtime_declaration) - Number(a.runtime_declaration)
    || Number(a.type_scaffolding) - Number(b.type_scaffolding)
    || b.symbol_overlap - a.symbol_overlap
    || b.lexical_score - a.lexical_score
    || compareCodeUnits(a.owner, b.owner));

  // Overloads and repeated declarations can produce the same owner more than
  // once. A shortlist must spend each slot on a distinct correction candidate.
  const seen = new Set<string>();
  return ranked.filter((candidate) => {
    if (seen.has(candidate.owner)) return false;
    seen.add(candidate.owner);
    return true;
  });
}

const ADAPTIVE_STOP_WORDS = new Set([
  "src", "source", "lib", "library", "package", "packages", "core", "index", "type", "types", "schema", "schemas",
  "test", "tests", "with", "from", "into", "this", "that", "when", "then", "value", "values", "error", "issue",
]);
const ADAPTIVE_TYPE_SCAFFOLD = /(?:Def|Internals?|Context|Options?|Params?|Input|Output|Config|Props|Type)$/;
const ADAPTIVE_GENERIC_ENTRANCE = /^(?:parse|parser|validate|validator|check|schema|error|assert|create|build|process|compile)$/i;

function adaptiveTerms(value: string): Set<string> {
  return new Set(value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .map((term) => term.replace(/^[$_]+/, ""))
    .filter((term) => term.length >= 3 && !ADAPTIVE_STOP_WORDS.has(term)));
}

function adaptiveOverlap(left: Set<string>, right: Set<string>): number {
  return [...left].filter((term) => right.has(term)).length;
}

function adaptiveComponentKeys(path: string): string[] {
  const parts = path.split("/");
  const directories = parts.slice(0, -1);
  const keys: string[] = [];
  for (let depth = Math.max(0, directories.length - 3); depth < directories.length; depth++) {
    const suffix = directories.slice(depth).join("/");
    if (suffix && !/^(?:src|lib|source|packages?)$/.test(suffix)) keys.push(suffix);
  }
  return keys;
}

function ownerPath(owner: string): string {
  return owner.slice(0, owner.indexOf("::"));
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function normalizedClaim(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function receiptId(receipt: Omit<CorrectionStageOptimizationReceipt, "receipt_id">): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex").slice(0, 24);
}

function optimizationReceipt(
  value: Omit<CorrectionStageOptimizationReceipt, "receipt_id">,
): CorrectionStageOptimizationReceipt {
  return { ...value, receipt_id: receiptId(value) };
}

/** Reserve a bounded portion of a shortlist for declarations proven to affect
 * the same authenticated behavior. File peers are included because the held
 * intervention experiments localized files more reliably than exact owners. */
export function reserveEvidenceGuidedOwners(
  baselineOwnersValue: string[],
  rankedOwnersValue: string[],
  evidenceMap: VerifiedEvidenceMap,
  requestedLimit = CORRECTION_STAGE_CANDIDATE_LIMIT,
): string[] {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CORRECTION_STAGE_CANDIDATE_LIMIT, requestedLimit))
    : CORRECTION_STAGE_CANDIDATE_LIMIT;
  const baselineOwners = distinct(baselineOwnersValue).slice(0, limit);
  if (!evidenceMap.verification.authenticated || evidenceMap.level !== "behavior-sensitive") return baselineOwners;

  const rankedOwners = distinct([...rankedOwnersValue, ...baselineOwners]);
  const rankedSet = new Set(rankedOwners);
  const sensitiveOwners = new Set(evidenceMap.intervention_slice.behavior_sensitive_owners);
  const sensitiveFiles = new Set(evidenceMap.intervention_slice.behavior_sensitive_files);
  const direct = rankedOwners.filter((owner) => sensitiveOwners.has(owner) && rankedSet.has(owner));
  const filePeers = rankedOwners.filter((owner) => !sensitiveOwners.has(owner) && sensitiveFiles.has(ownerPath(owner)));
  const baselineFloor = Math.min(EVIDENCE_GUIDED_BASELINE_FLOOR, limit);
  const slotLimit = Math.min(EVIDENCE_GUIDED_SLOT_LIMIT, Math.max(0, limit - baselineFloor));
  const evidenceOwners = distinct([...direct, ...filePeers]).slice(0, slotLimit);
  if (!evidenceOwners.length) return baselineOwners;
  return distinct([...evidenceOwners, ...baselineOwners, ...rankedOwners]).slice(0, limit);
}

export interface GuardedExecutionBridgeSelection {
  owner: string;
  path: string;
  strategy: "direct-high-contrast-execution" | "guarded-execution-file-peer";
  execution_ratio: number;
  static_rank: number;
}

/** Combine execution contrast with static plausibility. Files already covered
 * by the baseline are ignored, generic instrumentation files are excluded,
 * and only the final shortlist slot is eligible. Runtime evidence proposes a
 * bounded hypothesis; it never becomes an exact-owner claim. */
export function selectGuardedExecutionBridge(
  baselineOwnersValue: string[],
  rankedOwnersValue: string[],
  evidenceMap: VerifiedEvidenceMap,
  requestedLimit = CORRECTION_STAGE_CANDIDATE_LIMIT,
): GuardedExecutionBridgeSelection | null {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CORRECTION_STAGE_CANDIDATE_LIMIT, requestedLimit))
    : CORRECTION_STAGE_CANDIDATE_LIMIT;
  const baseline = distinct(baselineOwnersValue).slice(0, limit);
  const baselineFloor = Math.min(EXECUTION_GUIDED_BASELINE_FLOOR, limit);
  if (!evidenceMap.verification.authenticated || limit - baselineFloor < EXECUTION_GUIDED_SLOT_LIMIT) return null;

  const ranked = distinct(rankedOwnersValue);
  const rankByOwner = new Map(ranked.map((owner, index) => [owner, index + 1]));
  const baselineFiles = new Set(baseline.map(ownerPath));
  const eligibleEvidence = evidenceMap.execution_slice.strong_differential.filter((entry) => {
    const path = ownerPath(entry.owner);
    return !baselineFiles.has(path) && !EXECUTION_BRIDGE_INFRASTRUCTURE_PATH.test(path);
  });
  const paths = distinct(eligibleEvidence.map((entry) => ownerPath(entry.owner)));
  const choices = paths.flatMap((path): GuardedExecutionBridgeSelection[] => {
    const evidence = eligibleEvidence.filter((entry) => ownerPath(entry.owner) === path);
    const direct = evidence.flatMap((entry) => {
      const staticRank = rankByOwner.get(entry.owner);
      return staticRank !== undefined
        && staticRank <= EXECUTION_DIRECT_STATIC_RANK_MAX
        && entry.ratio >= EXECUTION_DIRECT_RATIO_MIN
        ? [{
          owner: entry.owner,
          path,
          strategy: "direct-high-contrast-execution" as const,
          execution_ratio: entry.ratio,
          static_rank: staticRank,
        }]
        : [];
    }).sort((left, right) => right.execution_ratio - left.execution_ratio
      || left.static_rank - right.static_rank
      || compareCodeUnits(left.owner, right.owner))[0];
    if (direct) return [direct];

    const maxRatio = evidence.reduce((best, entry) => Math.max(best, entry.ratio), 0);
    const peer = ranked.map((owner, index) => ({ owner, rank: index + 1 }))
      .find((item) => ownerPath(item.owner) === path && !baseline.includes(item.owner));
    return peer && peer.rank <= EXECUTION_FILE_STATIC_RANK_MAX && maxRatio >= EXECUTION_FILE_RATIO_MIN
      ? [{
        owner: peer.owner,
        path,
        strategy: "guarded-execution-file-peer" as const,
        execution_ratio: maxRatio,
        static_rank: peer.rank,
      }]
      : [];
  }).sort((left, right) => Number(right.strategy === "direct-high-contrast-execution")
    - Number(left.strategy === "direct-high-contrast-execution")
    || right.execution_ratio - left.execution_ratio
    || left.static_rank - right.static_rank
    || compareCodeUnits(left.owner, right.owner));
  return choices[0] ?? null;
}

export function reserveExecutionGuidedFileOwner(
  baselineOwnersValue: string[],
  rankedOwnersValue: string[],
  evidenceMap: VerifiedEvidenceMap,
  requestedLimit = CORRECTION_STAGE_CANDIDATE_LIMIT,
): string[] {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CORRECTION_STAGE_CANDIDATE_LIMIT, requestedLimit))
    : CORRECTION_STAGE_CANDIDATE_LIMIT;
  const baseline = distinct(baselineOwnersValue).slice(0, limit);
  const selection = selectGuardedExecutionBridge(baseline, rankedOwnersValue, evidenceMap, limit);
  return selection ? distinct([...baseline.slice(0, Math.min(EXECUTION_GUIDED_BASELINE_FLOOR, limit)), selection.owner]).slice(0, limit) : baseline;
}

/** Repository-adaptive replacement for fixed Zod path routing. It discovers
 * issue vocabulary in this repository's own paths and symbols, adds local
 * component consensus, and removes an invoked facade only when a deeper
 * repository-native candidate is available. */
export function rankIssueAdaptiveCorrectionCandidates(
  issueValue: unknown,
  sources: ContractAxisOwnerSource[],
): AdaptiveCorrectionStageCandidate[] {
  const issue = boundedIssue(issueValue);
  if (!issue) return [];
  const issueTerms = adaptiveTerms(issue);
  const invoked = new Set([...issue.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
    .map((match) => match[1]!.replace(/^[$_]+/, "").toLowerCase()));
  const runtime = runtimeDeclarationOwners(sources);
  const lexical = rankIssueImplementationOwners(issue, sources, 4_000)?.candidates ?? [];
  const distinct = lexical.filter((candidate, index, all) => all.findIndex((item) => item.owner === candidate.owner) === index);

  const prepared = distinct.map((candidate) => {
    const [path, symbol = ""] = candidate.owner.split("::");
    const pathOverlap = adaptiveOverlap(issueTerms, adaptiveTerms(path!));
    const symbolOverlap = adaptiveOverlap(issueTerms, adaptiveTerms(symbol));
    const direct = candidate.score + pathOverlap * 14 + symbolOverlap * 10;
    return { candidate, path: path!, symbol, pathOverlap, symbolOverlap, direct, keys: adaptiveComponentKeys(path!) };
  });
  const componentScores = new Map<string, number>();
  for (const item of prepared) {
    for (const key of item.keys) componentScores.set(key, Math.max(componentScores.get(key) ?? 0, item.direct));
  }

  const ranked = prepared.map((item) => {
    const normalized = item.symbol.replace(/^[$_]+/, "").toLowerCase();
    const invokedEntrance = invoked.has(normalized);
    const genericEntrance = ADAPTIVE_GENERIC_ENTRANCE.test(item.symbol);
    const typeScaffolding = ADAPTIVE_TYPE_SCAFFOLD.test(item.symbol);
    const componentSupport = item.keys.reduce((best, key) => Math.max(best, componentScores.get(key) ?? 0), 0);
    let score = item.direct + componentSupport * 0.12;
    if (runtime.has(item.candidate.owner)) score += 4;
    if (invokedEntrance) score -= 14;
    if (genericEntrance && item.pathOverlap === 0 && item.symbolOverlap === 0) score -= 8;
    if (typeScaffolding) score -= 3;
    return {
      owner: item.candidate.owner,
      stage: inferIssueCorrectionStage(issue),
      score: Math.round(score * 100) / 100,
      lexical_score: item.candidate.score,
      path_overlap: item.pathOverlap,
      symbol_overlap: item.symbolOverlap,
      component_support: Math.round(componentSupport * 100) / 100,
      runtime_declaration: runtime.has(item.candidate.owner),
      invoked_entrance: invokedEntrance,
      generic_entrance: genericEntrance,
      type_scaffolding: typeScaffolding,
    };
  }).sort((a, b) => b.score - a.score
    || b.path_overlap - a.path_overlap
    || b.symbol_overlap - a.symbol_overlap
    || Number(b.runtime_declaration) - Number(a.runtime_declaration)
    || compareCodeUnits(a.owner, b.owner));
  const deeper = ranked.filter((candidate) => !candidate.invoked_entrance
    && (candidate.path_overlap > 0 || candidate.symbol_overlap > 0));
  return deeper.length ? ranked.filter((candidate) => !candidate.invoked_entrance) : ranked;
}

export function optimizeIssueCorrectionCandidates(
  issueValue: unknown,
  sources: ContractAxisOwnerSource[],
  evidenceValue: unknown,
  requestedLimit = CORRECTION_STAGE_CANDIDATE_LIMIT,
): {
  candidates: EvidenceGuidedCorrectionStageCandidate[];
  receipt: CorrectionStageOptimizationReceipt;
  evidence_map: VerifiedEvidenceMap;
} {
  const issue = boundedIssue(issueValue);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CORRECTION_STAGE_CANDIDATE_LIMIT, requestedLimit))
    : CORRECTION_STAGE_CANDIDATE_LIMIT;
  const evidenceMap = compileVerifiedEvidenceMap(evidenceValue);
  const ranked = rankIssueAdaptiveCorrectionCandidates(issue, sources);
  const byOwner = new Map(ranked.map((candidate, index) => [candidate.owner, { candidate, baselineRank: index + 1 }]));
  const baseline = ranked.slice(0, limit).map((candidate) => candidate.owner);
  const claimBound = normalizedClaim(issue) === normalizedClaim(evidenceMap.claim);

  let reason: CorrectionStageOptimizationReceipt["reason"];
  let optimized = baseline;
  let evidenceStrategy: CorrectionStageOptimizationReceipt["evidence_strategy"] = null;
  let selectedExecutionRatio: number | null = null;
  let selectedStaticRank: number | null = null;
  if (!claimBound) {
    reason = "claim-mismatch";
  } else if (!evidenceMap.verification.authenticated) {
    reason = "probe-unverified";
  } else if (evidenceMap.level === "behavior-sensitive"
    || evidenceMap.execution_slice.strong_differential_files.length) {
    // Three fresh transfer cohorts rejected evidence-based shortlist mutation.
    // Preserve the observations on each candidate, but never let behavioral
    // influence masquerade as correction ownership in production.
    reason = "transfer-rejected-read-only";
  } else {
    reason = "no-actionable-evidence";
  }

  const baselineSet = new Set(baseline);
  const optimizedSet = new Set(optimized);
  const sensitiveOwners = new Set(evidenceMap.intervention_slice.behavior_sensitive_owners);
  const sensitiveFiles = new Set(evidenceMap.intervention_slice.behavior_sensitive_files);
  const targetOnly = new Set(evidenceMap.execution_slice.target_only_owners);
  const shared = new Set(evidenceMap.execution_slice.shared_owners);
  const strongDifferentialFiles = new Set(evidenceMap.execution_slice.strong_differential_files);
  const receiptWithoutId: Omit<CorrectionStageOptimizationReceipt, "receipt_id"> = {
    version: 3,
    rule: EVIDENCE_GUIDED_SHORTLIST_RULE,
    applied: false,
    reason,
    evidence_level: evidenceMap.level,
    probe_authenticated: evidenceMap.verification.authenticated,
    claim_bound: claimBound,
    requested_limit: limit,
    evidence_slots: optimized.filter((owner) => !baselineSet.has(owner)).length,
    evidence_strategy: evidenceStrategy,
    selected_execution_ratio: selectedExecutionRatio,
    selected_static_rank: selectedStaticRank,
    baseline_candidates: baseline,
    optimized_candidates: optimized,
    promoted_candidates: optimized.filter((owner) => !baselineSet.has(owner)),
    displaced_candidates: baseline.filter((owner) => !optimizedSet.has(owner)),
    behavior_sensitive_files: evidenceMap.intervention_slice.behavior_sensitive_files,
    strong_differential_files: evidenceMap.execution_slice.strong_differential_files,
    exact_owner_enabled: false,
  };
  return {
    candidates: optimized.flatMap((owner, index) => {
      const item = byOwner.get(owner);
      if (!item) return [];
      return [{
        ...item.candidate,
        baseline_rank: item.baselineRank,
        optimized_rank: index + 1,
        evidence: {
          behavior_sensitive_owner: sensitiveOwners.has(owner),
          behavior_sensitive_file: sensitiveFiles.has(ownerPath(owner)),
          target_only_execution: targetOnly.has(owner),
          shared_execution: shared.has(owner),
          strong_differential_file: strongDifferentialFiles.has(ownerPath(owner)),
        },
      }];
    }),
    receipt: optimizationReceipt(receiptWithoutId),
    evidence_map: evidenceMap,
  };
}

export function diagnoseIssueCorrectionStage(
  issueValue: unknown,
  sources: ContractAxisOwnerSource[],
  requestedLimit = CORRECTION_STAGE_CANDIDATE_LIMIT,
  evidenceValue?: unknown,
): CorrectionStageDiagnostic {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CORRECTION_STAGE_CANDIDATE_LIMIT, requestedLimit))
    : CORRECTION_STAGE_CANDIDATE_LIMIT;
  const optimized = evidenceValue === undefined
    ? null
    : optimizeIssueCorrectionCandidates(issueValue, sources, evidenceValue, limit);
  const ranked = rankIssueAdaptiveCorrectionCandidates(issueValue, sources);
  const candidates = optimized?.candidates ?? ranked.slice(0, limit);
  const fileFirstDeclarationClusters = buildFileFirstDeclarationClusters(ranked);
  const progressiveInspection = buildProgressiveDeclarationPlan(
    ranked,
    fileFirstDeclarationClusters,
    limit,
  );
  return {
    stage: inferIssueCorrectionStage(issueValue),
    likely_file: candidates[0]?.owner.split("::")[0] ?? null,
    candidates,
    file_first_declaration_clusters: fileFirstDeclarationClusters,
    progressive_inspection: progressiveInspection,
    exact_owner_enabled: false,
    optimization: optimized?.receipt ?? null,
    calibration: CORRECTION_STAGE_CALIBRATION,
    cross_repository_transfer: CORRECTION_STAGE_TRANSFER,
    adaptive_transfer: ADAPTIVE_CORRECTION_STAGE_TRANSFER,
    adaptive_replication: ADAPTIVE_CORRECTION_STAGE_REPLICATION,
    optimization_policy: CORRECTION_OPTIMIZATION_POLICY,
  };
}

export function formatCorrectionStageDiagnostic(diagnostic: CorrectionStageDiagnostic): string {
  const candidates = diagnostic.candidates.length
    ? diagnostic.candidates.map((candidate, index) => `  ${index + 1}. ${candidate.owner}`).join("\n")
    : "  (none — the issue did not resolve to a declaration in the selected stage)";
  const optimization = diagnostic.optimization
    ? [
      `Optimization: ${diagnostic.optimization.applied ? "applied" : "not applied"} — ${diagnostic.optimization.rule} (${diagnostic.optimization.reason})`,
      `Optimization receipt: ${diagnostic.optimization.receipt_id}`,
      `Evidence: ${diagnostic.optimization.evidence_level}; probe ${diagnostic.optimization.probe_authenticated ? "authenticated" : "not authenticated"}; claim ${diagnostic.optimization.claim_bound ? "bound" : "mismatch"}`,
      `Evidence strategy: ${diagnostic.optimization.evidence_strategy ?? "none"}`,
      `Promoted by evidence: ${diagnostic.optimization.promoted_candidates.join(", ") || "none"}`,
    ]
    : ["Optimization: no verified evidence receipt supplied"];
  const fileClusters = diagnostic.file_first_declaration_clusters.files.length
    ? diagnostic.file_first_declaration_clusters.files.flatMap((file) => [
      `  ${file.file_rank}. ${file.path} (file score ${file.file_score})`,
      ...file.declaration_clusters.map((cluster, index) =>
        `     ${index + 1}. ${cluster.label}: ${cluster.members.map((member) => member.owner).join(", ")}`),
    ])
    : ["  (none)"];
  const progressive = diagnostic.progressive_inspection.phases.flatMap((phase) => phase.candidates.length
    ? [
      `  ${phase.phase}: ${phase.instruction}`,
      ...phase.candidates.map((candidate) => `     ${candidate.inspection_rank}. ${candidate.owner}`),
      `     Stop: ${phase.stop_condition}`,
    ]
    : []);
  return [
    "Correction-stage diagnostic (experimental, read-only)",
    `Stage: ${diagnostic.stage}`,
    `Likely file: ${diagnostic.likely_file ?? "unknown"}`,
    ...optimization,
    "Candidate declarations (shortlist only):",
    candidates,
    `File-first declaration clusters (${diagnostic.file_first_declaration_clusters.receipt.rule}):`,
    ...fileClusters,
    `File-cluster receipt: ${diagnostic.file_first_declaration_clusters.receipt.receipt_id}`,
    `Progressive inspection plan (${diagnostic.progressive_inspection.receipt.rule}; max ${diagnostic.progressive_inspection.receipt.total_limit}):`,
    ...progressive,
    `Progressive-plan receipt: ${diagnostic.progressive_inspection.receipt.receipt_id}`,
    "Only experimentally promoted ranking mechanisms can change this queue; rejected evidence and causal-owner rerankers are annotation-only or disabled.",
    "Progressive-plan transfer: retained all 5/12 full-cluster hits with zero losses while reducing mean inspections from 18.9 to 11 (41.9%); it is an efficiency advisory, not an accuracy promotion (zero fresh rescues).",
    "File-cluster transfer: preserved union 6/12 vs flat top five 3/12 (+25 points); correct file 10/12 vs 8/12; three rescues; exact owner remains disabled.",
    "The flat shortlist is preserved; clusters are bounded inspection families, not exact-owner claims.",
    "Evidence is mixed: the repository-adaptive ranker passed its ArkType/class-validator holdout (top five 9/11; likely file 8/11), then failed a narrower tRPC/Elysia replication (top five 5/11; likely file 4/11). Per-case confidence and exact-owner claims are disabled.",
  ].join("\n");
}
