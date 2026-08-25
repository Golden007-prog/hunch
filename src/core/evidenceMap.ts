import { z } from "zod";

export const EvidenceOutcomeSchema = z.enum(["red", "green", "error", "not-run"]);

const ownerIsSafe = (value: string): boolean => {
  if (/\0|[\r\n]/.test(value)) return false;
  const separator = value.indexOf("::");
  if (separator <= 0 || separator === value.length - 2) return false;
  const path = value.slice(0, separator);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

export const EvidenceOwnerSchema = z.string().min(4).max(500).refine(
  ownerIsSafe,
  "owner must be a safe repo-relative path and declaration separated by ::",
);

export const EvidenceProbeSchema = z.object({
  target_before: EvidenceOutcomeSchema,
  control_before: EvidenceOutcomeSchema,
  target_after: EvidenceOutcomeSchema.optional(),
  control_after: EvidenceOutcomeSchema.optional(),
}).strict();

export const EvidenceExecutionSchema = z.object({
  owner: EvidenceOwnerSchema,
  target_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  control_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const EvidenceInterventionSchema = z.object({
  owner: EvidenceOwnerSchema,
  mutation_id: z.string().min(1).max(200).optional(),
  target_after: EvidenceOutcomeSchema,
  control_after: EvidenceOutcomeSchema,
}).strict();

export const VerifiedEvidenceReceiptSchema = z.object({
  version: z.literal(1),
  claim: z.string().trim().min(1).max(100_000),
  probe: EvidenceProbeSchema,
  execution: z.array(EvidenceExecutionSchema).max(500).default([]),
  interventions: z.array(EvidenceInterventionSchema).max(500).default([]),
}).strict();

export type EvidenceOutcome = z.infer<typeof EvidenceOutcomeSchema>;
export type VerifiedEvidenceReceipt = z.infer<typeof VerifiedEvidenceReceiptSchema>;

export interface EvidenceFile {
  path: string;
  target_execution_owners: string[];
  target_only_owners: string[];
  shared_execution_owners: string[];
  strong_differential_owners: string[];
  strong_differential_support: number;
  behavior_sensitive_owners: string[];
  evidence: Array<"target-execution" | "target-only-execution" | "shared-execution" | "strong-differential-execution" | "behavior-sensitive">;
}

export interface VerifiedEvidenceMap {
  version: 1;
  claim: string;
  level: "unverified" | "probe-authenticated" | "execution-verified" | "behavior-sensitive";
  verification: {
    authenticated: boolean;
    target_before: EvidenceOutcome;
    control_before: EvidenceOutcome;
    reason: string;
  };
  closure: {
    status: "unverified" | "open" | "still-red" | "closed" | "control-unchecked" | "control-regressed" | "probe-error";
    target_after: EvidenceOutcome | null;
    control_after: EvidenceOutcome | null;
  };
  execution_slice: {
    target_observed_owners: string[];
    target_only_owners: string[];
    shared_owners: string[];
    strong_differential_owners: string[];
    strong_differential_files: string[];
    strong_differential: Array<{
      owner: string;
      target_count: number;
      control_count: number;
      ratio: number;
    }>;
  };
  intervention_slice: {
    admitted_receipts: number;
    behavior_sensitive_owners: string[];
    behavior_sensitive_files: string[];
  };
  files: EvidenceFile[];
  owner_claim: {
    enabled: false;
    owner: null;
    reason: string;
  };
  limitations: string[];
}

function ownerPath(owner: string): string {
  return owner.slice(0, owner.indexOf("::"));
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function closureStatus(receipt: VerifiedEvidenceReceipt, authenticated: boolean): VerifiedEvidenceMap["closure"] {
  const target = receipt.probe.target_after ?? null;
  const control = receipt.probe.control_after ?? null;
  if (!authenticated) return { status: "unverified", target_after: target, control_after: control };
  if (!target || target === "not-run") return { status: "open", target_after: target, control_after: control };
  if (target === "error") return { status: "probe-error", target_after: target, control_after: control };
  if (target === "red") return { status: "still-red", target_after: target, control_after: control };
  if (control === "red" || control === "error") return { status: "control-regressed", target_after: target, control_after: control };
  if (!control || control === "not-run") return { status: "control-unchecked", target_after: target, control_after: control };
  return { status: "closed", target_after: target, control_after: control };
}

/** Compile externally observed receipts into a bounded evidence map. This is
 * deliberately pure: it runs no probe, edits no source, and never turns causal
 * influence into a correction-owner claim. */
export function compileVerifiedEvidenceMap(value: unknown): VerifiedEvidenceMap {
  const parsed = VerifiedEvidenceReceiptSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`).join("; ");
    throw new Error(`invalid verified-evidence receipt: ${details}`);
  }
  const receipt = parsed.data;
  const authenticated = receipt.probe.target_before === "red" && receipt.probe.control_before === "green";
  const verificationReason = authenticated
    ? "the target was red while the distinct control stayed green"
    : "authentication requires target_before=red and control_before=green";

  const executionByOwner = new Map<string, { target: number; control: number }>();
  for (const entry of receipt.execution) {
    const current = executionByOwner.get(entry.owner) ?? { target: 0, control: 0 };
    current.target = Math.max(current.target, entry.target_count);
    current.control = Math.max(current.control, entry.control_count);
    executionByOwner.set(entry.owner, current);
  }
  const targetObserved = unique([...executionByOwner].filter(([, counts]) => counts.target > 0).map(([owner]) => owner));
  const targetOnly = unique([...executionByOwner].filter(([, counts]) => counts.target > 0 && counts.control === 0).map(([owner]) => owner));
  const shared = unique([...executionByOwner].filter(([, counts]) => counts.target > 0 && counts.control > 0).map(([owner]) => owner));
  // A single target-only call is often setup noise. The transfer-development
  // rule therefore requires at least two target calls and a 2x target/control
  // ratio before execution may reserve one file-level shortlist slot.
  const strongDifferential = unique([...executionByOwner]
    .filter(([, counts]) => counts.target > counts.control && counts.target >= 2 * Math.max(1, counts.control))
    .map(([owner]) => owner));
  const strongDifferentialFiles = unique(strongDifferential.map(ownerPath));
  const strongDifferentialEntries = strongDifferential.map((owner) => {
    const counts = executionByOwner.get(owner)!;
    return {
      owner,
      target_count: counts.target,
      control_count: counts.control,
      ratio: counts.target / Math.max(1, counts.control),
    };
  });
  const admitted = authenticated
    ? receipt.interventions.filter((entry) => entry.target_after === "green" && entry.control_after === "green")
    : [];
  const behaviorSensitive = unique(admitted.map((entry) => entry.owner));
  const sensitiveFiles = unique(behaviorSensitive.map(ownerPath));

  const paths = unique([...targetObserved.map(ownerPath), ...sensitiveFiles]);
  const files = paths.map((path): EvidenceFile => {
    const targetExecutionOwners = targetObserved.filter((owner) => ownerPath(owner) === path);
    const targetOnlyOwners = targetOnly.filter((owner) => ownerPath(owner) === path);
    const sharedOwners = shared.filter((owner) => ownerPath(owner) === path);
    const strongDifferentialOwners = strongDifferential.filter((owner) => ownerPath(owner) === path);
    const strongDifferentialSupport = strongDifferentialOwners.reduce((support, owner) => {
      const counts = executionByOwner.get(owner)!;
      return support + counts.target - counts.control;
    }, 0);
    const sensitiveOwners = behaviorSensitive.filter((owner) => ownerPath(owner) === path);
    const evidence = [
      ...(targetExecutionOwners.length ? ["target-execution" as const] : []),
      ...(targetOnlyOwners.length ? ["target-only-execution" as const] : []),
      ...(sharedOwners.length ? ["shared-execution" as const] : []),
      ...(strongDifferentialOwners.length ? ["strong-differential-execution" as const] : []),
      ...(sensitiveOwners.length ? ["behavior-sensitive" as const] : []),
    ];
    return {
      path,
      target_execution_owners: targetExecutionOwners,
      target_only_owners: targetOnlyOwners,
      shared_execution_owners: sharedOwners,
      strong_differential_owners: strongDifferentialOwners,
      strong_differential_support: strongDifferentialSupport,
      behavior_sensitive_owners: sensitiveOwners,
      evidence,
    };
  });

  const level: VerifiedEvidenceMap["level"] = !authenticated
    ? "unverified"
    : behaviorSensitive.length
      ? "behavior-sensitive"
      : targetObserved.length
        ? "execution-verified"
        : "probe-authenticated";
  return {
    version: 1,
    claim: receipt.claim,
    level,
    verification: {
      authenticated,
      target_before: receipt.probe.target_before,
      control_before: receipt.probe.control_before,
      reason: verificationReason,
    },
    closure: closureStatus(receipt, authenticated),
    execution_slice: {
      target_observed_owners: targetObserved,
      target_only_owners: targetOnly,
      shared_owners: shared,
      strong_differential_owners: strongDifferential,
      strong_differential_files: strongDifferentialFiles,
      strong_differential: strongDifferentialEntries,
    },
    intervention_slice: {
      admitted_receipts: admitted.length,
      behavior_sensitive_owners: behaviorSensitive,
      behavior_sensitive_files: sensitiveFiles,
    },
    files,
    owner_claim: {
      enabled: false,
      owner: null,
      reason: "Execution and successful interventions establish behavioral influence, not correction ownership.",
    },
    limitations: [
      "The compiler trusts supplied observations; it does not execute or independently authenticate probes.",
      "Unexecuted code and unsupported mutation shapes remain outside the evidence slice.",
      "A behavior-sensitive declaration may be an upstream lever, wrapper, or downstream symptom site rather than the correction owner.",
    ],
  };
}

function listed(values: string[]): string {
  return values.length ? values.map((value) => `  - ${value}`).join("\n") : "  (none)";
}

export function formatVerifiedEvidenceMap(map: VerifiedEvidenceMap): string {
  return [
    "Verified evidence map (read-only receipt compiler)",
    `Claim: ${map.claim}`,
    `Evidence level: ${map.level}`,
    `Probe authentication: ${map.verification.authenticated ? "authenticated" : "not authenticated"} — ${map.verification.reason}`,
    `Closure: ${map.closure.status}`,
    "Target-only execution:",
    listed(map.execution_slice.target_only_owners),
    "Shared execution:",
    listed(map.execution_slice.shared_owners),
    "Strong differential execution files:",
    listed(map.execution_slice.strong_differential_files),
    "Behavior-sensitive files:",
    listed(map.intervention_slice.behavior_sensitive_files),
    `Exact-owner claim: disabled — ${map.owner_claim.reason}`,
    "This command compiled supplied observations; it did not run code or mutate the repository.",
  ].join("\n");
}
