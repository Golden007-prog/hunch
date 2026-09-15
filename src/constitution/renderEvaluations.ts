/** Terminal rendering of canonical policy receipts, shared by `hunch policy
 * evaluate` and the pre-commit `hunch check`. Rendering never alters a receipt.
 * Receipts that did not evaluate (error / unknown / not_applicable) and share
 * one explanation are grouped, so ten policies failing for the same
 * environmental reason read as one actionable block instead of ten
 * (fnd_b421b3f7ab); satisfied and violated policies always stay one per line. */
import type { PolicyEvaluationSet } from "./service.js";

const ICON: Record<string, string> = { satisfied: "✅", violated: "⛔", not_applicable: "·", unknown: "?", error: "‼" };
const GROUP_AT = 3;

function groupKey(r: PolicyEvaluationSet): string {
  const result = r.evaluation.result;
  const groupable = (result === "error" || result === "unknown" || result === "not_applicable") && !r.blocks && !r.gate_error;
  if (!groupable) return `one ${r.policy.id}`;
  return `${r.policy.state} ${result} ${r.evaluation.explanation}`;
}

/** The cause of a grouped non-evaluation in a few words: the explanation up to
 * its first parenthesis, semicolon or dash, so "no dependency snapshot cache
 * exists on this machine (.hunch-cache/behavior-deps); executable behavior …"
 * reads as its first clause. */
function shortCause(explanation: string): string {
  const cut = explanation.split(/[(;]| — /)[0]!.trim();
  return cut.length > 110 ? `${cut.slice(0, 109).trimEnd()}…` : cut;
}

export interface RenderPolicyOptions {
  /** Commit-time rendering: a grouped non-evaluation is one line and satisfied
   * receipts collapse to one line. Violations, blocks and gate errors always
   * render in full. `hunch policy evaluate` keeps the complete form. */
  compact?: boolean;
}

export function renderPolicyEvaluations(results: PolicyEvaluationSet[], options: RenderPolicyOptions = {}): string[] {
  if (!results.length) return ["No Constitution policies matched."];
  const out = [`Constitution policy evaluation: ${results.length} canonical receipt(s)`];
  if (options.compact) {
    const satisfied = results.filter((r) => r.evaluation.result === "satisfied" && !r.blocks && !r.gate_error);
    if (satisfied.length > 1) {
      out.push(`  ✅ ${satisfied.length} policies satisfied: ${satisfied.map((r) => r.policy.id).join(", ")}`);
      results = results.filter((r) => !satisfied.includes(r));
    }
  }
  const groups = new Map<string, PolicyEvaluationSet[]>();
  for (const r of results) {
    const key = groupKey(r);
    const members = groups.get(key) ?? [];
    members.push(r);
    groups.set(key, members);
  }
  const rendered = new Set<PolicyEvaluationSet>();
  for (const r of results) {
    if (rendered.has(r)) continue;
    const members = groups.get(groupKey(r)) ?? [r];
    const icon = ICON[r.evaluation.result] ?? "·";
    if (members.length >= GROUP_AT) {
      for (const member of members) rendered.add(member);
      const ids = members.map((m) => m.policy.id);
      const receipts = members.map((m) => `${m.policy.id}=${m.evaluation.deterministic_hash.slice(0, 17)}`);
      if (options.compact) {
        // One line per cause at commit time; the ids and receipts are one command away.
        out.push(`  ${icon} ${members.length} policies [${r.policy.state}] ${r.evaluation.result} — ${shortCause(r.evaluation.explanation)} · hunch policy evaluate for ids and receipts`);
        continue;
      }
      out.push(`  ${icon} ${members.length} policies [${r.policy.state}] ${r.evaluation.result} — same cause`);
      out.push(`     ${r.evaluation.explanation}`);
      out.push(`     policies: ${ids.join(", ")}`);
      out.push(`     receipts: ${receipts.join(" ")}`);
      out.push("     full receipts: hunch policy evaluate --json");
      continue;
    }
    rendered.add(r);
    out.push(`  ${icon} ${r.policy.id} [${r.policy.state}] ${r.evaluation.result}${r.blocks ? " — BLOCK" : ""}`);
    out.push(`     ${r.evaluation.explanation}`);
    if (r.gate_error) out.push(`     gate error: ${r.gate_error}`);
    out.push(`     receipt: ${r.evaluation.deterministic_hash}`);
  }
  return out;
}
