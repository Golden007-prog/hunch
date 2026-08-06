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
import { externalImportNodeId } from "./externalImports.js";
import { isInForce } from "./topics.js";
import type { Decision, ConformancePredicate, Edge, Symbol as HunchSymbol } from "./types.js";

export interface ConformanceResult {
  decision: string;
  title: string;
  assert: string;
  subject: string;
  object?: string;
  satisfied: boolean;
  detail: string;
}

export type ConformanceGraph = { symbols: HunchSymbol[]; edges: Edge[] };

function resolveSymbols(graph: ConformanceGraph, ref: string): Array<{ id: string; name: string; file: string }> {
  const syms = graph.symbols;
  if (ref.startsWith("sym_")) return syms.filter((s) => s.id === ref);
  if (ref.includes(":")) {
    const split = ref.lastIndexOf(":");
    const file = ref.slice(0, split);
    const name = ref.slice(split + 1);
    return syms.filter((s) => s.name === name && (s.file === file || s.file.endsWith("/" + file)));
  }
  return syms.filter((s) => s.name === ref);
}

function reaches(graph: ConformanceGraph, id: string, transitive: boolean): Set<string> {
  const reached = new Set<string>();
  const seen = new Set([id]);
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
  const maxDepth = transitive ? 6 : 1;
  const traversable = new Set(["calls", "depends_on", "imports", "contains"]);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!traversable.has(edge.type)) continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const next of outgoing.get(current.id) ?? []) {
      reached.add(next);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }
  return reached;
}

function evalPredicate(graph: ConformanceGraph, d: Decision, p: ConformancePredicate): ConformanceResult {
  const base = { decision: d.id, title: d.title, assert: p.assert, subject: p.subject, object: p.object };
  const subjects = resolveSymbols(graph, p.subject);

  if (p.assert === "exists") {
    return { ...base, satisfied: subjects.length > 0, detail: subjects.length ? `${p.subject} exists (${subjects.map((subject) => subject.file).join(", ")})` : `${p.subject} no longer exists in the graph` };
  }
  if (!subjects.length) return { ...base, satisfied: false, detail: `subject "${p.subject}" not found in the graph — intent's subject is gone` };

  const wantReach = p.assert === "calls" || p.assert === "imports";
  const objects = p.object ? resolveSymbols(graph, p.object) : [];
  // An external package is a VIRTUAL graph node (`ext_<hash>`, see core/externalImports.ts),
  // never a Symbol record — so resolveSymbols can NEVER find one. Without this, every
  // `not-imports <symbol> <package>` predicate fell straight into the "target not found ⇒
  // a forbidden relation trivially holds" branch below and reported ✅ forever, while the
  // graph right beside it recorded the violating `imports` edge. Resolve the package from
  // the edge set instead, which is where the indexer actually puts it.
  const externalId = p.object ? externalImportNodeId(p.object) : null;
  const objectIds = objects.length
    ? objects.map((o) => o.id)
    : externalId && graph.edges.some((e) => e.to === externalId)
      ? [externalId]
      : [];
  if (!objectIds.length) {
    // a required target gone ⇒ the link can't hold (violated); a forbidden one trivially
    // holds — nothing can reach a node the graph does not contain.
    return { ...base, satisfied: !wantReach, detail: `target "${p.object ?? ""}" not found in the graph` };
  }
  // A required relation cannot guess which same-name symbol carries the intent.
  // Force qualification instead of accidentally proving a different binding.
  if (wantReach && (subjects.length !== 1 || objectIds.length !== 1)) {
    return {
      ...base,
      satisfied: false,
      detail: `ambiguous required binding (${subjects.length} subject, ${objectIds.length} target matches) — qualify as file:symbol; intent VIOLATED`,
    };
  }
  // A forbidden relation is conservative in the other direction: ANY matching
  // subject reaching ANY same-name target is a real counterexample. Looking at
  // only the first target lets a duplicate symbol hide a violation.
  const linked = subjects.some((subject) => {
    const reached = reaches(graph, subject.id, p.transitive);
    return objectIds.some((id) => reached.has(id));
  });
  const satisfied = wantReach ? linked : !linked;
  const via = p.transitive ? " (transitively)" : "";
  const detail = satisfied
    ? wantReach
      ? `${p.subject} →${via} ${p.object} ✓`
      : `${p.subject} does not reach ${p.object} ✓`
    : wantReach
      ? `${p.subject} no longer reaches${via} ${p.object} — intent VIOLATED`
      : `${p.subject} now reaches${via} ${p.object} — intent VIOLATED`;
  return { ...base, satisfied, detail };
}

/** Check every in-force decision's conformance predicates against the CURRENT graph.
 *  `.satisfied === false` means the code drifted from the recorded intent. Deterministic.
 *  `publicOnly` selects every input at the JSON read boundary so a private decision,
 *  symbol, or edge can never influence (or be rendered into) a public CI receipt. */
export function checkConformance(
  store: HunchStore,
  opts: { publicOnly?: boolean; graph?: ConformanceGraph } = {},
): ConformanceResult[] {
  const load = <K extends "decisions" | "symbols" | "edges">(kind: K) =>
    opts.publicOnly ? store.json.loadAll(kind) : store.recs(kind);
  const graph: ConformanceGraph = opts.graph ?? { symbols: load("symbols"), edges: load("edges") };
  const out: ConformanceResult[] = [];
  for (const d of load("decisions")) {
    if (!isInForce(d)) continue; // in-force only — a REJECTED intent is not an intent
    for (const p of d.conformance ?? []) out.push(evalPredicate(graph, d, p));
  }
  return out;
}
