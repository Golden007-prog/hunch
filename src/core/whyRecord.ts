/** `hunch_why(<record id>)` (issue #474): every brief line Hunch delivers ends in
 *  `hunch_why("dec_…")`, so why() must resolve a record id, not only a path/symbol.
 *  The lookup lives in HunchStore.why(); this module holds the id shape and the one
 *  renderer the MCP tool and the CLI share, so the two surfaces cannot drift apart. */
import type { Bug, Component, Constraint, Decision, Finding } from "./types.js";

/** Targets why() tries as a record id first. Generated ids are `<prefix>_<hex>`
 *  (shortHash), but hand-written/imported ids (`dec_session_transport`) are valid too. */
export const WHY_RECORD_ID = /^(dec|con|bug|cmp|fnd)_[A-Za-z0-9_-]+$/;
/** The generated id shape: only a miss on THIS shape is reported as "No record <id>";
 *  any other miss (e.g. a symbol named `bug_handler`) falls through to path/symbol lookup. */
export const WHY_GENERATED_ID = /^(dec|con|bug|cmp|fnd)_[0-9a-f]{6,}$/;

/** One link of a decision's supersession chain, oldest first. */
export interface WhyChainLink { id: string; status: string; title: string }

export type WhyRecord =
  | { kind: "decision"; record: Decision; chain: WhyChainLink[] }
  | { kind: "constraint"; record: Constraint }
  | { kind: "bug"; record: Bug }
  | { kind: "finding"; record: Finding }
  | { kind: "component"; record: Component };

/** The by-id half of a WhyResult: `record` is null when no visible record has the id
 *  (or, with `asOf`, none was in force at that instant). */
export interface WhyById { id: string; record: WhyRecord | null; asOf?: string }

/** Per-list cap in hunch_why output, and the "what was withheld" note after a capped
 *  list — shared with the path/symbol view in the MCP server. */
export const WHY_CAP = 6;
export const more = (total: number, cap: number, hint = ""): string =>
  total > cap ? `\n  …(+${total - cap} more${hint ? ` — ${hint}` : ""})` : "";
const PROSE_CHARS = 600;
const ITEM_CHARS = 240;

const clip = (text: string, max = PROSE_CHARS): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  // By code point, so a cut never splits a surrogate pair (emoji, astral CJK).
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};
const list = (label: string, items: readonly string[]): string[] =>
  items.length ? [`  ${label}:`, ...items.slice(0, WHY_CAP).map((i) => `    - ${clip(i, ITEM_CHARS)}`), ...(items.length > WHY_CAP ? [`    ${more(items.length, WHY_CAP).trim()}`] : [])] : [];
const files = (label: string, items: readonly string[]): string[] =>
  items.length ? [`  ${label}: ${items.slice(0, WHY_CAP).join(", ")}${items.length > WHY_CAP ? ` …(+${items.length - WHY_CAP} more)` : ""}`] : [];

/** Plain-text detail lines for a record looked up by id. */
export function formatWhyRecord(byId: WhyById): string[] {
  const hit = byId.record;
  if (!hit) {
    return [byId.asOf
      ? `No record ${byId.id} as of ${byId.asOf} (it did not exist or was not in force then).`
      : `No record ${byId.id} (no decision, constraint, bug, finding, or component has that id).`];
  }
  const out: string[] = [];
  switch (hit.kind) {
    case "decision": {
      const d = hit.record;
      out.push(`DECISION ${d.id} [${d.status}] ${d.title}`);
      if (d.topic) out.push(`  topic: ${d.topic}`);
      if (d.decision) out.push(`  decision: ${clip(d.decision)}`);
      if (d.context) out.push(`  context: ${clip(d.context)}`);
      out.push(...list("rejected alternatives", d.alternatives_rejected), ...list("consequences", d.consequences));
      out.push(...files("files", d.related_files));
      if (d.supersedes) out.push(`  supersedes: ${d.supersedes}`);
      if (d.superseded_by) out.push(`  superseded by: ${d.superseded_by}`);
      if (hit.chain.length > 1) {
        // A WHY_CAP window that always holds the queried decision: the newest links
        // when it is near the end, otherwise starting at it.
        const at = Math.max(0, hit.chain.findIndex((c) => c.id === d.id));
        const start = Math.max(0, Math.min(at, hit.chain.length - WHY_CAP));
        const end = Math.min(hit.chain.length, start + WHY_CAP);
        out.push("  chain (oldest first):");
        if (start > 0) out.push(`    …(+${start} earlier)`);
        out.push(...hit.chain.slice(start, end).map((c) => `    - ${c.id} [${c.status}] ${clip(c.title, ITEM_CHARS)}${c.id === d.id ? " ←" : ""}`));
        if (end < hit.chain.length) out.push(`    …(+${hit.chain.length - end} later)`);
      }
      break;
    }
    case "constraint": {
      const c = hit.record;
      out.push(`CONSTRAINT ${c.id} [${c.severity}/${c.status}] ${clip(c.statement)}`);
      out.push(...(c.scope.length ? files("scope", c.scope) : ["  scope: repo"]));
      if (c.rationale) out.push(`  rationale: ${clip(c.rationale)}`);
      if (c.source_decision) out.push(`  source decision: ${c.source_decision}`);
      break;
    }
    case "bug": {
      const b = hit.record;
      out.push(`BUG ${b.id} [${b.status}/${b.severity}] ${b.title}`);
      if (b.symptom) out.push(`  symptom: ${clip(b.symptom)}`);
      if (b.root_cause) out.push(`  root cause: ${clip(b.root_cause)}`);
      if (b.lineage.fixed_commit) out.push(`  fixed in: ${b.lineage.fixed_commit}`);
      out.push(...files("files", b.affected_files));
      break;
    }
    case "finding": {
      const f = hit.record;
      out.push(`FINDING ${f.id} [${f.triage}/${f.severity}] ${f.title}`);
      if (f.observation) out.push(`  observation: ${clip(f.observation)}`);
      out.push(...list("evidence", f.evidence));
      out.push(...files("files", f.affected_files));
      break;
    }
    case "component": {
      const c = hit.record;
      out.push(`COMPONENT ${c.id} [${c.kind}/${c.status}] ${c.name}`);
      if (c.responsibility) out.push(`  responsibility: ${clip(c.responsibility)}`);
      out.push(...files("paths", c.paths));
      break;
    }
  }
  const p = hit.record.provenance;
  out.push(`  provenance: ${p.source}, confidence ${p.confidence}`);
  return out;
}
