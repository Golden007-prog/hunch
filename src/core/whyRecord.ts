/** `hunch_why(<record id>)` (issue #474): every brief line Hunch delivers ends in
 *  `hunch_why("dec_…")`, so why() must resolve a record id, not only a path/symbol.
 *  The lookup lives in HunchStore.why(); this module holds the id shape and the one
 *  renderer the MCP tool and the CLI share, so the two surfaces cannot drift apart. */
import type { Bug, Component, Constraint, Decision, Finding } from "./types.js";

/** Record-id shapes why() resolves by id. Ids are `<prefix>_<hex>` (shortHash). */
export const WHY_RECORD_ID = /^(dec|con|bug|cmp|fnd)_[0-9a-f]+$/;

/** One link of a decision's supersession chain, oldest first. */
export interface WhyChainLink { id: string; status: string; title: string }

export type WhyRecord =
  | { kind: "decision"; record: Decision; chain: WhyChainLink[] }
  | { kind: "constraint"; record: Constraint }
  | { kind: "bug"; record: Bug }
  | { kind: "finding"; record: Finding }
  | { kind: "component"; record: Component };

/** The by-id half of a WhyResult: `record` is null when no visible record has the id. */
export interface WhyById { id: string; record: WhyRecord | null }

const list = (label: string, items: readonly string[]): string[] =>
  items.length ? [`  ${label}:`, ...items.map((i) => `    - ${i}`)] : [];

/** Plain-text detail lines for a record looked up by id. */
export function formatWhyRecord(byId: WhyById): string[] {
  const hit = byId.record;
  if (!hit) return [`No record ${byId.id} (no decision, constraint, bug, finding, or component has that id).`];
  const out: string[] = [];
  switch (hit.kind) {
    case "decision": {
      const d = hit.record;
      out.push(`DECISION ${d.id} [${d.status}] ${d.title}`);
      if (d.topic) out.push(`  topic: ${d.topic}`);
      if (d.decision) out.push(`  decision: ${d.decision}`);
      if (d.context) out.push(`  context: ${d.context}`);
      out.push(...list("rejected alternatives", d.alternatives_rejected), ...list("consequences", d.consequences));
      if (d.related_files.length) out.push(`  files: ${d.related_files.join(", ")}`);
      if (d.supersedes) out.push(`  supersedes: ${d.supersedes}`);
      if (d.superseded_by) out.push(`  superseded by: ${d.superseded_by}`);
      if (hit.chain.length > 1) out.push(`  chain (oldest first): ${hit.chain.map((c) => `${c.id} [${c.status}]${c.id === d.id ? " ←" : ""}`).join(" → ")}`);
      break;
    }
    case "constraint": {
      const c = hit.record;
      out.push(`CONSTRAINT ${c.id} [${c.severity}/${c.status}] ${c.statement}`);
      out.push(`  scope: ${c.scope.join(", ") || "repo"}`);
      if (c.rationale) out.push(`  rationale: ${c.rationale}`);
      if (c.source_decision) out.push(`  source decision: ${c.source_decision}`);
      break;
    }
    case "bug": {
      const b = hit.record;
      out.push(`BUG ${b.id} [${b.status}/${b.severity}] ${b.title}`);
      if (b.symptom) out.push(`  symptom: ${b.symptom}`);
      if (b.root_cause) out.push(`  root cause: ${b.root_cause}`);
      if (b.lineage.fixed_commit) out.push(`  fixed in: ${b.lineage.fixed_commit}`);
      if (b.affected_files.length) out.push(`  files: ${b.affected_files.join(", ")}`);
      break;
    }
    case "finding": {
      const f = hit.record;
      out.push(`FINDING ${f.id} [${f.triage}/${f.severity}] ${f.title}`);
      if (f.observation) out.push(`  observation: ${f.observation}`);
      out.push(...list("evidence", f.evidence));
      if (f.affected_files.length) out.push(`  files: ${f.affected_files.join(", ")}`);
      break;
    }
    case "component": {
      const c = hit.record;
      out.push(`COMPONENT ${c.id} [${c.kind}/${c.status}] ${c.name}`);
      if (c.responsibility) out.push(`  responsibility: ${c.responsibility}`);
      if (c.paths.length) out.push(`  paths: ${c.paths.join(", ")}`);
      break;
    }
  }
  const p = hit.record.provenance;
  out.push(`  provenance: ${p.source}, confidence ${p.confidence}`);
  return out;
}
