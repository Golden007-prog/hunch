import { z } from "zod";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { PolicyAssertionSchema } from "./schema.js";

const ScopeSchema = z.object({
  repos: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
}).strict();

const CompilerOutcomeSchema = z.object({
  outcome: z.enum(["assertion", "uncompilable", "conflicted", "covered"]),
  assertion: PolicyAssertionSchema.optional(),
  scope: ScopeSchema.optional(),
  uncertainty: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  incumbent: z.string().nullable().default(null),
  reason: z.string().default(""),
}).strict().superRefine((value, context) => {
  if (value.outcome === "assertion" && (!value.assertion || !value.scope)) {
    context.addIssue({ code: "custom", message: "assertion outcomes require exact assertion and scope" });
  }
  if (value.outcome !== "assertion" && (value.assertion || value.scope)) {
    context.addIssue({ code: "custom", message: "non-assertion outcomes cannot smuggle assertion semantics" });
  }
});

export const CompilerCaseBankSchema = z.object({
  version: z.literal(1),
  experiment: z.literal("EXP-03"),
  threshold: z.number().min(0).max(1).default(0.7),
  preregistered_metric: z.literal("intended supported assertion or honest non-minting classification"),
  cases: z.array(z.object({
    id: z.string().regex(/^exp03_[a-z0-9_]+$/),
    family: z.string().min(1),
    evidence: z.string().min(1),
    expected: CompilerOutcomeSchema,
    actual: CompilerOutcomeSchema,
  }).strict()).min(20),
}).strict();

export type CompilerCaseBank = z.infer<typeof CompilerCaseBankSchema>;

export interface CompilerScorecard {
  experiment: "EXP-03";
  denominator: number;
  numerator: number;
  incorrect: number;
  silent_semantic_substitutions: number;
  rate: number;
  threshold: number;
  risk_difference_vs_threshold: number;
  wilson_95: { low: number; high: number };
  passed: boolean;
  by_outcome: Record<"assertion" | "uncompilable" | "conflicted" | "covered", { total: number; correct: number }>;
  cases: Array<{ id: string; family: string; correct: boolean; silent_substitution: boolean; reason: string }>;
  deterministic_hash: string;
}

function semanticOutcome(value: z.infer<typeof CompilerOutcomeSchema>): unknown {
  return value.outcome === "assertion"
    ? { outcome: value.outcome, assertion: value.assertion, scope: value.scope }
    : { outcome: value.outcome, conflicts: [...value.conflicts].sort(), incumbent: value.incumbent };
}

function wilson(successes: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 0 };
  const z95 = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z95 * z95) / total;
  const centre = p + (z95 * z95) / (2 * total);
  const spread = z95 * Math.sqrt((p * (1 - p) + (z95 * z95) / (4 * total)) / total);
  return { low: (centre - spread) / denominator, high: (centre + spread) / denominator };
}

/** Score only exact semantic outcomes. Wording/reason text is diagnostic and
 * never rescues a wrong assertion. An expected refusal that becomes any
 * assertion is counted separately as a silent semantic substitution. */
export function scoreCompilerCaseBank(raw: unknown): CompilerScorecard {
  const bank = CompilerCaseBankSchema.parse(raw);
  const details = bank.cases.map((item) => {
    const semanticMatch = canonicalJson(semanticOutcome(item.expected)) === canonicalJson(semanticOutcome(item.actual));
    const uncertaintyMatch = item.actual.uncertainty.length >= item.expected.uncertainty.length;
    const correct = semanticMatch && uncertaintyMatch;
    const silentSubstitution = item.expected.outcome !== "assertion" && item.actual.outcome === "assertion";
    return {
      id: item.id,
      family: item.family,
      correct,
      silent_substitution: silentSubstitution,
      reason: correct ? "exact intended semantics" : silentSubstitution ? "unsupported meaning was silently substituted" : "actual compiler classification differs from the reviewed expectation",
    };
  });
  const numerator = details.filter((item) => item.correct).length;
  const denominator = details.length;
  const rate = numerator / denominator;
  const byOutcome = Object.fromEntries(["assertion", "uncompilable", "conflicted", "covered"].map((outcome) => {
    const matching = bank.cases.map((item, index) => ({ item, detail: details[index]! })).filter(({ item }) => item.expected.outcome === outcome);
    return [outcome, { total: matching.length, correct: matching.filter(({ detail }) => detail.correct).length }];
  })) as CompilerScorecard["by_outcome"];
  const body = {
    experiment: "EXP-03" as const,
    denominator,
    numerator,
    incorrect: denominator - numerator,
    silent_semantic_substitutions: details.filter((item) => item.silent_substitution).length,
    rate,
    threshold: bank.threshold,
    risk_difference_vs_threshold: rate - bank.threshold,
    wilson_95: wilson(numerator, denominator),
    passed: rate >= bank.threshold && details.every((item) => !item.silent_substitution),
    by_outcome: byOutcome,
    cases: details,
  };
  return { ...body, deterministic_hash: canonicalHash(body) };
}

export function renderCompilerScorecard(card: CompilerScorecard): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `EXP-03 Intent Compiler scorecard — ${card.passed ? "PASS" : "FAIL"}`,
    `  primary: ${card.numerator}/${card.denominator} (${pct(card.rate)}) exact or honest outcomes`,
    `  threshold: ${pct(card.threshold)} · risk difference: ${(card.risk_difference_vs_threshold * 100).toFixed(1)} pp`,
    `  Wilson 95% interval: ${pct(card.wilson_95.low)}–${pct(card.wilson_95.high)}`,
    `  silent semantic substitutions: ${card.silent_semantic_substitutions}`,
    ...Object.entries(card.by_outcome).map(([outcome, result]) => `  ${outcome}: ${result.correct}/${result.total}`),
    `  receipt: ${card.deterministic_hash}`,
  ].join("\n");
}
