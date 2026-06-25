/**
 * Intent-conformance (the inversion). Today's guards ask "did this diff touch a guarded
 * file?". This asks the deeper question: "does the code, right now, still SATISFY the
 * intent a decision recorded?" — by compiling that intent into a DETERMINISTIC check over
 * the symbol/dependency graph Hunch already builds. "pay must verify the session" becomes
 * `pay` reaches `verifySession`; if the code drifts so it no longer does, the intent is
 * violated even though no diff is in scope. No model — pure graph reachability.
 *
 * Note: reachability is over the unified dependency graph (call / import / depends-on /
 * contains edges), so `calls` and `imports` both mean "must reach"; edge-type precision is
 * a later refinement. The point this proves: code can be checked AGAINST intent.
 */
import type { HunchStore } from "../store/hunchStore.js";
import type { Decision, ConformancePredicate } from "./types.js";

export interface ConformanceResult {
  decision: string;
  title: string;
  assert: string;
  subject: string;
  object?: string;
  satisfied: boolean;
  detail: string;
}

function resolveSymbol(store: HunchStore, ref: string): { id: string; name: string; file: string } | null {
  const syms = store.recs("symbols");
  if (ref.startsWith("sym_")) return syms.find((s) => s.id === ref) ?? null;
  if (ref.includes(":")) {
    const [f, n] = ref.split(":");
    return syms.find((s) => s.name === n && (s.file === f || s.file.endsWith("/" + (f ?? "")))) ?? null;
  }
  return syms.find((s) => s.name === ref) ?? null;
}

function reaches(store: HunchStore, id: string, transitive: boolean): Set<string> {
  const set = new Set<string>();
  for (const d of store.getDependencies(id, transitive ? 6 : 1)) {
    if (transitive || d.depth === 1) set.add(d.id);
  }
  return set;
}

function evalPredicate(store: HunchStore, d: Decision, p: ConformancePredicate): ConformanceResult {
  const base = { decision: d.id, title: d.title, assert: p.assert, subject: p.subject, object: p.object };
  const subj = resolveSymbol(store, p.subject);

  if (p.assert === "exists") {
    return { ...base, satisfied: !!subj, detail: subj ? `${p.subject} exists (${subj.file})` : `${p.subject} no longer exists in the graph` };
  }
  if (!subj) return { ...base, satisfied: false, detail: `subject "${p.subject}" not found in the graph — intent's subject is gone` };

  const wantReach = p.assert === "calls" || p.assert === "imports";
  const obj = p.object ? resolveSymbol(store, p.object) : null;
  if (!obj) {
    // a required target gone ⇒ the link can't hold (violated); a forbidden one trivially holds.
    return { ...base, satisfied: !wantReach, detail: `target "${p.object ?? ""}" not found in the graph` };
  }
  const linked = reaches(store, subj.id, p.transitive).has(obj.id);
  const satisfied = wantReach ? linked : !linked;
  const via = p.transitive ? " (transitively)" : "";
  const detail = satisfied
    ? wantReach
      ? `${subj.name} →${via} ${obj.name} ✓`
      : `${subj.name} does not reach ${obj.name} ✓`
    : wantReach
      ? `${subj.name} no longer reaches${via} ${obj.name} — intent VIOLATED`
      : `${subj.name} now reaches${via} ${obj.name} — intent VIOLATED`;
  return { ...base, satisfied, detail };
}

/** Check every in-force decision's conformance predicates against the CURRENT graph.
 *  `.satisfied === false` means the code drifted from the recorded intent. Deterministic. */
export function checkConformance(store: HunchStore): ConformanceResult[] {
  const out: ConformanceResult[] = [];
  for (const d of store.recs("decisions")) {
    if (d.status === "superseded" || d.superseded_by) continue; // in-force decisions only
    for (const p of d.conformance ?? []) out.push(evalPredicate(store, d, p));
  }
  return out;
}
