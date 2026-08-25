import { createHash } from "node:crypto";

export const FILE_FIRST_DECLARATION_CLUSTER_RULE = "flat-file-anchored-semantic-clusters-v3" as const;
export const FILE_FIRST_FILE_LIMIT = 5;
export const FILE_FIRST_CLUSTER_LIMIT = 2;
export const FILE_FIRST_MEMBER_LIMIT = 3;
export const PROGRESSIVE_DECLARATION_PLAN_RULE = "promoted-only-progressive-inspection-v4" as const;
export const PROGRESSIVE_DECLARATION_BASELINE_LIMIT = 5;
export const PROGRESSIVE_DECLARATION_PRIMARY_LIMIT = 10;
export const PROGRESSIVE_DECLARATION_TOTAL_LIMIT = 11;
export const FILE_FIRST_DECLARATION_CLUSTER_TRANSFER = {
  benchmark: "flat-file-anchored-clusters-transfer-v3",
  scorable_tasks: 12,
  baseline_top_five_hits: 3,
  combined_hits: 6,
  combined_improvement_points: 0.25,
  baseline_file_hits: 8,
  cluster_file_hits: 10,
  rescues: 3,
  average_inspected_declarations: 18.83,
  max_inspected_declarations: 24,
  decision: "promoted-supplemental-diagnostic",
  exact_owner_policy: "disabled",
} as const;
export const PROGRESSIVE_DECLARATION_DEVELOPMENT = {
  benchmark: "revealed-cluster-transfer-v1-v2-v3-replay",
  scorable_tasks: 36,
  baseline_top_five_hits: 15,
  progressive_plan_hits: 21,
  full_cluster_union_hits: 21,
  previous_average_inspected_declarations: 19.81,
  progressive_max_inspected_declarations: 11,
  inspection_reduction: 0.4446,
  decision: "candidate-awaiting-fresh-transfer",
  exact_owner_policy: "disabled",
} as const;
export const PROGRESSIVE_DECLARATION_TRANSFER = {
  benchmark: "progressive-inspection-cross-repository-transfer-v4",
  scorable_tasks: 12,
  baseline_top_five_hits: 5,
  progressive_plan_hits: 5,
  full_cluster_union_hits: 5,
  rescues: 0,
  losses: 0,
  average_inspected_declarations: 11,
  previous_average_inspected_declarations: 18.92,
  inspection_reduction: 0.4185,
  decision: "retain-efficiency-advisory-v4",
  accuracy_promotion: "rejected-no-fresh-rescue",
  exact_owner_policy: "disabled",
} as const;

export interface ClusterableDeclarationCandidate {
  owner: string;
  score: number;
  runtime_declaration: boolean;
  type_scaffolding: boolean;
}

export interface DeclarationClusterMember {
  owner: string;
  global_rank: number;
  static_score: number;
  runtime_declaration: boolean;
  type_scaffolding: boolean;
}

export interface SemanticDeclarationCluster {
  cluster_id: string;
  label: string;
  semantic_terms: string[];
  representative: string;
  representative_global_rank: number;
  members: DeclarationClusterMember[];
  members_truncated: number;
}

export interface FileFirstDeclarationCluster {
  path: string;
  file_rank: number;
  file_score: number;
  first_candidate_rank: number;
  declaration_clusters: SemanticDeclarationCluster[];
}

export interface FileFirstDeclarationClusterReceipt {
  version: 3;
  receipt_id: string;
  rule: typeof FILE_FIRST_DECLARATION_CLUSTER_RULE;
  source_candidates: number;
  file_limit: number;
  cluster_limit_per_file: number;
  member_limit_per_cluster: number;
  selected_files: string[];
  selected_cluster_ids: string[];
  file_selection_strategy: "flat-shortlist-file-anchor";
  flat_shortlist_anchor_size: 5;
  flat_shortlist_preserved: true;
  exact_owner_enabled: false;
}

export interface FileFirstDeclarationDiagnostic {
  files: FileFirstDeclarationCluster[];
  receipt: FileFirstDeclarationClusterReceipt;
  transfer_calibration: typeof FILE_FIRST_DECLARATION_CLUSTER_TRANSFER;
}

export interface ProgressiveInspectionCandidate {
  owner: string;
  inspection_rank: number;
  phase: "flat-shortlist" | "cluster-expansion" | "cluster-fallback";
  file_path: string;
  global_rank: number;
  cluster_id: string | null;
  cluster_label: string | null;
  runtime_declaration: boolean;
  type_scaffolding: boolean;
}

export interface ProgressiveInspectionPhase {
  phase: ProgressiveInspectionCandidate["phase"];
  instruction: string;
  stop_condition: string;
  candidates: ProgressiveInspectionCandidate[];
}

export interface ProgressiveDeclarationPlanReceipt {
  version: 1;
  receipt_id: string;
  rule: typeof PROGRESSIVE_DECLARATION_PLAN_RULE;
  baseline_limit: number;
  primary_limit: number;
  total_limit: number;
  selected_owners: string[];
  selected_cluster_ids: string[];
  promoted_mechanisms: readonly ["repository-adaptive-ranking", "flat-file-anchored-semantic-clusters"];
  rejected_rerankers_disabled: true;
  flat_shortlist_preserved: true;
  exact_owner_enabled: false;
}

export interface ProgressiveDeclarationPlan {
  phases: ProgressiveInspectionPhase[];
  candidates: ProgressiveInspectionCandidate[];
  receipt: ProgressiveDeclarationPlanReceipt;
  development_calibration: typeof PROGRESSIVE_DECLARATION_DEVELOPMENT;
  transfer_calibration: typeof PROGRESSIVE_DECLARATION_TRANSFER;
}

const SEMANTIC_STOP_WORDS = new Set([
  "src", "source", "lib", "library", "package", "packages", "core", "index",
  "schema", "schemas", "type", "types", "zod", "mini", "internals", "internal",
  "params", "param", "options", "option", "context", "config", "props", "def",
  "input", "output", "result", "results", "handle", "handler", "get", "set",
  "make", "create", "build", "process", "processor", "run", "apply", "with",
  "from", "into", "this", "that", "value", "values",
]);

function ownerPath(owner: string): string {
  return owner.slice(0, owner.indexOf("::"));
}

function ownerSymbol(owner: string): string {
  return owner.slice(owner.indexOf("::") + 2);
}

function semanticTerms(symbol: string): string[] {
  return [...new Set(symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !SEMANTIC_STOP_WORDS.has(term)))];
}

function fallbackTerm(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]+/g, "").toLowerCase() || "anonymous";
}

function overlap(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((term) => rightSet.has(term)).length;
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

interface MutableCluster {
  terms: string[];
  label: string;
  members: DeclarationClusterMember[];
}

function clusterFileDeclarations(
  path: string,
  candidates: Array<{ candidate: ClusterableDeclarationCandidate; globalRank: number }>,
  clusterLimit: number,
  memberLimit: number,
): SemanticDeclarationCluster[] {
  const clusters: MutableCluster[] = [];
  for (const item of candidates) {
    const symbol = ownerSymbol(item.candidate.owner);
    const terms = semanticTerms(symbol);
    const effectiveTerms = terms.length ? terms : [fallbackTerm(symbol)];
    const matching = clusters.map((cluster, index) => ({ index, overlap: overlap(effectiveTerms, cluster.terms) }))
      .filter((entry) => entry.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap || left.index - right.index)[0];
    const member: DeclarationClusterMember = {
      owner: item.candidate.owner,
      global_rank: item.globalRank,
      static_score: item.candidate.score,
      runtime_declaration: item.candidate.runtime_declaration,
      type_scaffolding: item.candidate.type_scaffolding,
    };
    if (matching) {
      const cluster = clusters[matching.index]!;
      cluster.terms = [...new Set([...cluster.terms, ...effectiveTerms])].sort();
      cluster.members.push(member);
    } else {
      clusters.push({ terms: effectiveTerms, label: effectiveTerms.join(" / "), members: [member] });
    }
  }

  return clusters.slice(0, clusterLimit).map((cluster) => {
    const members = cluster.members.slice(0, memberLimit);
    const representative = members[0]!;
    const value = {
      path,
      terms: cluster.terms,
      representative: representative.owner,
      members: members.map((member) => member.owner),
    };
    return {
      cluster_id: shortHash(value),
      label: cluster.label,
      semantic_terms: cluster.terms,
      representative: representative.owner,
      representative_global_rank: representative.global_rank,
      members,
      members_truncated: Math.max(0, cluster.members.length - members.length),
    };
  });
}

/** Build a hierarchical diagnostic from the existing static ranking. The flat
 * shortlist remains untouched: this view collapses related declaration
 * scaffolding into semantic families so one noisy family cannot consume every
 * inspection slot inside a promising file. It is still a candidate view, not
 * an exact-owner claim. */
export function buildFileFirstDeclarationClusters(
  rankedCandidatesValue: ClusterableDeclarationCandidate[],
  requestedFileLimit = FILE_FIRST_FILE_LIMIT,
  requestedClusterLimit = FILE_FIRST_CLUSTER_LIMIT,
  requestedMemberLimit = FILE_FIRST_MEMBER_LIMIT,
): FileFirstDeclarationDiagnostic {
  const fileLimit = Number.isSafeInteger(requestedFileLimit)
    ? Math.max(1, Math.min(FILE_FIRST_FILE_LIMIT, requestedFileLimit))
    : FILE_FIRST_FILE_LIMIT;
  const clusterLimit = Number.isSafeInteger(requestedClusterLimit)
    ? Math.max(1, Math.min(FILE_FIRST_CLUSTER_LIMIT, requestedClusterLimit))
    : FILE_FIRST_CLUSTER_LIMIT;
  const memberLimit = Number.isSafeInteger(requestedMemberLimit)
    ? Math.max(1, Math.min(FILE_FIRST_MEMBER_LIMIT, requestedMemberLimit))
    : FILE_FIRST_MEMBER_LIMIT;
  const distinctCandidates = rankedCandidatesValue.filter((candidate, index, all) =>
    all.findIndex((entry) => entry.owner === candidate.owner) === index);
  const byFile = new Map<string, Array<{ candidate: ClusterableDeclarationCandidate; globalRank: number }>>();
  distinctCandidates.forEach((candidate, index) => {
    const path = ownerPath(candidate.owner);
    const entries = byFile.get(path) ?? [];
    entries.push({ candidate, globalRank: index + 1 });
    byFile.set(path, entries);
  });

  const prepared = [...byFile].map(([path, entries]) => {
    const allClusters = clusterFileDeclarations(path, entries, Number.MAX_SAFE_INTEGER, memberLimit);
    const scoringClusters = allClusters.slice(0, clusterLimit);
    return {
      path,
      firstCandidateRank: entries[0]!.globalRank,
      fileScore: Math.round(scoringClusters.reduce((sum, cluster) =>
        sum + (cluster.members[0]?.static_score ?? 0), 0) * 100) / 100,
      clusters: scoringClusters,
    };
  }).sort((left, right) => right.fileScore - left.fileScore
    || left.firstCandidateRank - right.firstCandidateRank
    || left.path.localeCompare(right.path));

  // The first design re-ranked files by aggregate family score and lost a file
  // already represented by the working flat shortlist on fresh transfer. V2
  // makes the hierarchy supplemental in fact as well as name: preserve every
  // distinct file from the flat top five first, then use aggregate scoring only
  // to fill any remaining file slots.
  const flatFileAnchors = [...new Set(distinctCandidates.slice(0, 5).map((candidate) => ownerPath(candidate.owner)))];
  const selectedPaths = [...new Set([...flatFileAnchors, ...prepared.map((entry) => entry.path)])].slice(0, fileLimit);
  const selected = selectedPaths.flatMap((path) => {
    const entry = prepared.find((candidate) => candidate.path === path);
    return entry ? [entry] : [];
  });

  const files: FileFirstDeclarationCluster[] = selected.map((entry, index) => ({
    path: entry.path,
    file_rank: index + 1,
    file_score: entry.fileScore,
    first_candidate_rank: entry.firstCandidateRank,
    declaration_clusters: entry.clusters,
  }));
  const receiptWithoutId = {
    version: 3 as const,
    rule: FILE_FIRST_DECLARATION_CLUSTER_RULE,
    source_candidates: distinctCandidates.length,
    file_limit: fileLimit,
    cluster_limit_per_file: clusterLimit,
    member_limit_per_cluster: memberLimit,
    selected_files: files.map((file) => file.path),
    selected_cluster_ids: files.flatMap((file) => file.declaration_clusters.map((cluster) => cluster.cluster_id)),
    file_selection_strategy: "flat-shortlist-file-anchor" as const,
    flat_shortlist_anchor_size: 5 as const,
    flat_shortlist_preserved: true as const,
    exact_owner_enabled: false as const,
  };
  return {
    files,
    receipt: { ...receiptWithoutId, receipt_id: shortHash(receiptWithoutId) },
    transfer_calibration: FILE_FIRST_DECLARATION_CLUSTER_TRANSFER,
  };
}

/** Turn the promoted flat shortlist and semantic clusters into a progressive
 * inspection queue. The first five candidates remain byte-for-byte intact.
 * Supplemental candidates must already belong to a selected semantic family,
 * and are ordered by the frozen repository-adaptive rank instead of widening
 * to every declaration in the file. The last slot is explicitly a fallback so
 * callers can stop after ten inspections when the behavior is already owned. */
export function buildProgressiveDeclarationPlan(
  rankedCandidatesValue: ClusterableDeclarationCandidate[],
  clusters: FileFirstDeclarationDiagnostic,
  requestedBaselineLimit = PROGRESSIVE_DECLARATION_BASELINE_LIMIT,
  requestedTotalLimit = PROGRESSIVE_DECLARATION_TOTAL_LIMIT,
): ProgressiveDeclarationPlan {
  const baselineLimit = Number.isSafeInteger(requestedBaselineLimit)
    ? Math.max(1, Math.min(PROGRESSIVE_DECLARATION_BASELINE_LIMIT, requestedBaselineLimit))
    : PROGRESSIVE_DECLARATION_BASELINE_LIMIT;
  const totalLimit = Number.isSafeInteger(requestedTotalLimit)
    ? Math.max(baselineLimit, Math.min(PROGRESSIVE_DECLARATION_TOTAL_LIMIT, requestedTotalLimit))
    : PROGRESSIVE_DECLARATION_TOTAL_LIMIT;
  const primaryLimit = Math.min(PROGRESSIVE_DECLARATION_PRIMARY_LIMIT, totalLimit);
  const distinctCandidates = rankedCandidatesValue.filter((candidate, index, all) =>
    all.findIndex((entry) => entry.owner === candidate.owner) === index);
  const byOwner = new Map(distinctCandidates.map((candidate, index) => [candidate.owner, {
    candidate,
    globalRank: index + 1,
  }]));
  const clusterMembership = new Map<string, {
    clusterId: string;
    clusterLabel: string;
    filePath: string;
    fileRank: number;
  }>();
  for (const file of clusters.files) {
    for (const cluster of file.declaration_clusters) {
      for (const member of cluster.members) {
        if (!clusterMembership.has(member.owner)) {
          clusterMembership.set(member.owner, {
            clusterId: cluster.cluster_id,
            clusterLabel: cluster.label,
            filePath: file.path,
            fileRank: file.file_rank,
          });
        }
      }
    }
  }

  const baselineOwners = distinctCandidates.slice(0, baselineLimit).map((candidate) => candidate.owner);
  const baselineSet = new Set(baselineOwners);
  const expansion = clusters.files.flatMap((file) => file.declaration_clusters.flatMap((cluster) =>
    cluster.members.map((member) => ({ member, fileRank: file.file_rank, clusterId: cluster.cluster_id }))))
    .filter((entry, index, all) => !baselineSet.has(entry.member.owner)
      && all.findIndex((candidate) => candidate.member.owner === entry.member.owner) === index)
    .sort((left, right) => left.member.global_rank - right.member.global_rank
      || Number(right.member.runtime_declaration) - Number(left.member.runtime_declaration)
      || Number(left.member.type_scaffolding) - Number(right.member.type_scaffolding)
      || left.fileRank - right.fileRank
      || left.clusterId.localeCompare(right.clusterId)
      || left.member.owner.localeCompare(right.member.owner))
    .slice(0, Math.max(0, totalLimit - baselineOwners.length));

  const baseline: ProgressiveInspectionCandidate[] = baselineOwners.flatMap((owner, index) => {
    const ranked = byOwner.get(owner);
    if (!ranked) return [];
    const membership = clusterMembership.get(owner);
    return [{
      owner,
      inspection_rank: index + 1,
      phase: "flat-shortlist" as const,
      file_path: ownerPath(owner),
      global_rank: ranked.globalRank,
      cluster_id: membership?.clusterId ?? null,
      cluster_label: membership?.clusterLabel ?? null,
      runtime_declaration: ranked.candidate.runtime_declaration,
      type_scaffolding: ranked.candidate.type_scaffolding,
    }];
  });
  const supplemental: ProgressiveInspectionCandidate[] = expansion.map((entry, index) => {
    const membership = clusterMembership.get(entry.member.owner);
    const inspectionRank = baseline.length + index + 1;
    return {
      owner: entry.member.owner,
      inspection_rank: inspectionRank,
      phase: inspectionRank <= primaryLimit ? "cluster-expansion" : "cluster-fallback",
      file_path: membership?.filePath ?? ownerPath(entry.member.owner),
      global_rank: entry.member.global_rank,
      cluster_id: membership?.clusterId ?? null,
      cluster_label: membership?.clusterLabel ?? null,
      runtime_declaration: entry.member.runtime_declaration,
      type_scaffolding: entry.member.type_scaffolding,
    };
  });
  const candidates = [...baseline, ...supplemental];
  const phases: ProgressiveInspectionPhase[] = [
    {
      phase: "flat-shortlist",
      instruction: "Inspect the preserved repository-adaptive shortlist first.",
      stop_condition: "Stop when one candidate explains and reproduces the behavior; otherwise expand within the anchored files.",
      candidates: baseline,
    },
    {
      phase: "cluster-expansion",
      instruction: "Inspect the strongest remaining declarations from the selected semantic families.",
      stop_condition: "Stop by inspection ten when a family owns the behavior; use the final fallback only while ownership remains unresolved.",
      candidates: supplemental.filter((candidate) => candidate.phase === "cluster-expansion"),
    },
    {
      phase: "cluster-fallback",
      instruction: "Inspect one final ranked family member without widening to another file.",
      stop_condition: "After this bounded fallback, report uncertainty instead of generating more owner guesses.",
      candidates: supplemental.filter((candidate) => candidate.phase === "cluster-fallback"),
    },
  ];
  const receiptWithoutId = {
    version: 1 as const,
    rule: PROGRESSIVE_DECLARATION_PLAN_RULE,
    baseline_limit: baselineLimit,
    primary_limit: primaryLimit,
    total_limit: totalLimit,
    selected_owners: candidates.map((candidate) => candidate.owner),
    selected_cluster_ids: [...new Set(candidates.flatMap((candidate) => candidate.cluster_id ? [candidate.cluster_id] : []))],
    promoted_mechanisms: ["repository-adaptive-ranking", "flat-file-anchored-semantic-clusters"] as const,
    rejected_rerankers_disabled: true as const,
    flat_shortlist_preserved: true as const,
    exact_owner_enabled: false as const,
  };
  return {
    phases,
    candidates,
    receipt: { ...receiptWithoutId, receipt_id: shortHash(receiptWithoutId) },
    development_calibration: PROGRESSIVE_DECLARATION_DEVELOPMENT,
    transfer_calibration: PROGRESSIVE_DECLARATION_TRANSFER,
  };
}
