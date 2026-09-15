/** Ranking of task records for pre-edit delivery (dec_66925aa0ee).
 *
 * Pure functions over plain data: no I/O, no clock, no model. The store gathers
 * candidates and computes the corpus-level inputs (dependents, co-change, IDF,
 * lexical scores, anchor liveness); this module gates, scores, slots and
 * explains. Same inputs always give the same picks, so a selection is
 * replayable and every line carries the reasons that produced it.
 *
 * Design, from the research synthesis: gate before rank (unfiltered injection
 * is what lost in every negative result), structure over similarity, verified
 * outcome as the importance proxy, recency as a decayed term with a floor and
 * never a cutoff, convex weighted sum (not RRF, which degenerates on short
 * lists), IDF-weighted overlap instead of Jaccard on tiny id sets, slots plus
 * MMR instead of a flat top-k, one factual reason per pick. */
import type { TaskRecord } from "./types.js";

export interface RankingQuery {
  /** File (posix path) or phrase the agent is working on. */
  target: string;
  /** Files this task has already touched (from its ledger). */
  files: ReadonlySet<string>;
  /** Record ids delivered, applied or saved in this task so far. */
  recordIds: ReadonlySet<string>;
  /** Task title (opt-in) or the hunch_context phrase; null when unknown. */
  phrase: string | null;
  /** Milliseconds since epoch; passed in so ranking is replayable. */
  now: number;
}

export interface CochangeStrength {
  /** Commits in which the file and the target changed together. */
  count: number;
  /** count / max(commits touching either), in [0, 1]. */
  strength: number;
}

export interface RankingContext {
  /** Files that depend on the target or share its component (posix paths). */
  dependents: ReadonlySet<string>;
  /** Co-change strength per file, for files that changed with the target. */
  cochange: ReadonlyMap<string, CochangeStrength>;
  /** Corpus statistics for a record id across all task records. */
  ruleStats: (recordId: string) => { idf: number; df: number };
  /** bm25 of the query phrase over task title + lesson titles, normalized to the top hit. */
  lexical: ReadonlyMap<string, number>;
  /** Fraction of a record's files that still exist; 1 when it names no files. */
  anchorsAlive: (record: TaskRecord) => number;
  /** Task ids some later record supersedes; never delivered. */
  superseded?: ReadonlySet<string>;
  /** Last time a task line was delivered (ms since epoch), when receipts know. */
  lastDelivered?: (taskId: string) => number | null;
}

export interface RankingWeights {
  file: number; rules: number; outcome: number; lexical: number; recency: number; workingSet: number;
}
/** A prior, not a measurement. Changed only through `hunch task rank-eval`. */
export const DEFAULT_WEIGHTS: Readonly<RankingWeights> = Object.freeze({
  file: 0.30, rules: 0.25, outcome: 0.15, lexical: 0.10, recency: 0.10, workingSet: 0.10,
});
export const RECENCY_HALF_LIFE_DAYS = 30;
export const RECENCY_FLOOR = 0.1;
export const COCHANGE_MIN_COUNT = 2;
/** A shared record admits a candidate only when it is informative: present in
 * at most half of all task records (idf ≥ ln 2). A rule every task receives
 * says nothing about relatedness; it still contributes to the score, weakly. */
export const RULE_GATE_MIN_IDF = Math.log(2);

export type RankingTerm = keyof RankingWeights;

export interface RankedTask {
  record: TaskRecord;
  score: number;
  terms: Record<RankingTerm, number>;
  /** Factual reasons, strongest first (weighted term contribution). */
  reasons: string[];
  anchorsAlive: number;
  /** True when the record names the exact target file. */
  exactFile: boolean;
  /** True when a delivered rule was violated or a check failed in the record. */
  problem: boolean;
}

export type SlotName = "latest" | "violation" | "relevant";
export interface SlotPick { slot: SlotName; ranked: RankedTask }
export interface TaskSelection {
  picks: SlotPick[];
  /** Ranked candidates not shown. */
  more: number;
  candidates: number;
  /** How the picks were chosen: the ranker, or the "latest 3" fallback the kill rule imposes. */
  mode?: "ranked" | "latest";
}

/** The pre-ranking behaviour, kept as the baseline and the fallback: the three
 * most recent records on the exact file, no scoring. */
export function selectLatestTasks(records: readonly TaskRecord[], query: RankingQuery, ctx: RankingContext, limit = 3): TaskSelection {
  const target = normalizePath(query.target);
  const ranked = records
    .filter((r) => !ctx.superseded?.has(r.id) && recordFiles(r).includes(target))
    .map((r) => rankTaskRecord(r, query, ctx))
    .filter((r): r is RankedTask => r !== null)
    .sort(newestFirst);
  const picks: SlotPick[] = ranked.slice(0, Math.max(1, limit)).map((r) => ({ slot: "latest" as const, ranked: r }));
  return { picks, more: ranked.length - picks.length, candidates: ranked.length, mode: "latest" };
}

export interface SlotOptions { limit?: number; relevant?: number; lambda?: number }

const DAY_MS = 86_400_000;

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Every record id a task record references: lessons received, applications, saves. */
export function recordIdsOf(record: TaskRecord): Set<string> {
  const ids = new Set<string>();
  for (const l of record.lessons) ids.add(l.record_id);
  for (const a of record.applied) ids.add(a.record_id);
  for (const s of record.saved) ids.add(s.record_id);
  return ids;
}

function recordFiles(record: TaskRecord): string[] {
  return record.files.map(normalizePath);
}

/** Age from the later of finishing and the last delivery: a record that keeps
 * being delivered stays warm (access-based decay, as in Generative Agents). */
function ageDays(record: TaskRecord, now: number, lastDelivered: number | null = null): number {
  const finished = Date.parse(record.finished_at);
  const anchor = Math.max(Number.isFinite(finished) ? finished : Number.NEGATIVE_INFINITY, lastDelivered ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(anchor)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - anchor) / DAY_MS);
}

export function recencyTerm(record: TaskRecord, now: number, lastDelivered: number | null = null): number {
  const days = ageDays(record, now, lastDelivered);
  if (!Number.isFinite(days)) return RECENCY_FLOOR;
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

export function outcomeTerm(record: TaskRecord): { value: number; reason: string | null } {
  if (record.conformance.some((c) => c.outcome === "violated")) return { value: 1, reason: "RULE VIOLATED" };
  if (record.checks.some((c) => c.state === "failed" || c.state === "timed out")) return { value: 0.8, reason: "check failed" };
  if (record.saved.length) return { value: 0.6, reason: `saved ${record.saved[0]!.record_id}${record.saved.length > 1 ? ` +${record.saved.length - 1}` : ""}` };
  if (record.applied.some((a) => a.supported_by)) return { value: 0.5, reason: "applied a rule (rule-supported)" };
  if (record.checks.some((c) => c.state === "passed")) return { value: 0.3, reason: "check passed" };
  return { value: 0, reason: null };
}

function humanAge(days: number): string {
  if (!Number.isFinite(days)) return "undated";
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  return `${Math.floor(days)} days ago`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Gate, score and explain one record. Null when the gate rejects it. */
export function rankTaskRecord(record: TaskRecord, query: RankingQuery, ctx: RankingContext, weights: Readonly<RankingWeights> = DEFAULT_WEIGHTS): RankedTask | null {
  const target = normalizePath(query.target);
  if (ctx.superseded?.has(record.id)) return null; // a later task verified over it
  const files = recordFiles(record);
  const alive = files.length ? ctx.anchorsAlive(record) : 1;
  if (files.length && alive === 0) return null; // nothing it names still exists

  // --- file: same file 1, dependent / same component 0.5, co-change 0.3 × strength-ish
  const exactFile = files.includes(target);
  const dependent = !exactFile && files.some((f) => ctx.dependents.has(f));
  let cochangeHit: { file: string; count: number } | null = null;
  if (!exactFile && !dependent) {
    for (const f of files) {
      const c = ctx.cochange.get(f);
      if (c && c.count >= COCHANGE_MIN_COUNT && (!cochangeHit || c.count > cochangeHit.count)) cochangeHit = { file: f, count: c.count };
    }
  }
  const fileValue = exactFile ? 1 : dependent ? 0.5 : cochangeHit ? 0.3 : 0;

  // --- rules: IDF-weighted intersection over the current task's own ids
  const ids = recordIdsOf(record);
  const shared: Array<{ id: string; idf: number; df: number }> = [];
  let queryMass = 0;
  for (const id of query.recordIds) {
    const s = ctx.ruleStats(id);
    queryMass += s.idf;
    if (ids.has(id)) shared.push({ id, ...s });
  }
  const rulesValue = queryMass > 0 ? Math.min(1, shared.reduce((sum, s) => sum + s.idf, 0) / queryMass) : 0;

  // --- gate: structure or an informative shared rule; lexical/recency/outcome alone never admit
  const informative = shared.some((s) => s.idf >= RULE_GATE_MIN_IDF);
  if (fileValue === 0 && !informative) return null;

  const outcome = outcomeTerm(record);
  const lexicalValue = Math.max(0, Math.min(1, ctx.lexical.get(record.id) ?? 0));
  const lastDelivered = ctx.lastDelivered?.(record.id) ?? null;
  const recencyValue = recencyTerm(record, query.now, lastDelivered);
  const touched = files.filter((f) => query.files.has(f));
  const workingSetValue = query.files.size ? Math.min(1, touched.length / query.files.size) : 0;

  const terms: Record<RankingTerm, number> = {
    file: fileValue, rules: rulesValue, outcome: outcome.value, lexical: lexicalValue, recency: recencyValue, workingSet: workingSetValue,
  };
  const score = (Object.keys(terms) as RankingTerm[]).reduce((sum, k) => sum + weights[k] * terms[k], 0);

  // --- reasons, ordered by weighted contribution
  const reasons: Array<{ weight: number; text: string }> = [];
  if (exactFile) reasons.push({ weight: weights.file * 1, text: "same file" });
  else if (dependent) reasons.push({ weight: weights.file * 0.5, text: `dependent of ${target}` });
  else if (cochangeHit) reasons.push({ weight: weights.file * 0.3, text: `co-changed with ${target} in ${cochangeHit.count} commits` });
  if (shared.length) {
    const top = [...shared].sort((a, b) => b.idf - a.idf)[0]!;
    reasons.push({ weight: weights.rules * rulesValue, text: `shares ${top.id}${top.df ? ` (${top.df === 1 ? "only here" : `${top.df} tasks`})` : ""}${shared.length > 1 ? ` +${shared.length - 1}` : ""}` });
  }
  if (outcome.reason) reasons.push({ weight: weights.outcome * outcome.value, text: outcome.reason });
  if (lexicalValue > 0 && query.phrase) reasons.push({ weight: weights.lexical * lexicalValue, text: `matches "${clip(query.phrase, 40)}"` });
  if (touched.length) reasons.push({ weight: weights.workingSet * workingSetValue, text: `also touched ${touched[0]} this task` });
  const finishedAge = ageDays(record, query.now);
  const effectiveAge = ageDays(record, query.now, lastDelivered);
  reasons.push({ weight: weights.recency * recencyValue, text: effectiveAge < finishedAge ? `delivered ${humanAge(effectiveAge)}` : humanAge(finishedAge) });
  if (alive < 1) reasons.push({ weight: 0, text: "files since changed" });
  reasons.sort((a, b) => b.weight - a.weight);

  return {
    record, score, terms, reasons: reasons.map((r) => r.text), anchorsAlive: alive, exactFile,
    problem: outcome.value >= 0.8,
  };
}

/** Newest first, then id — the tie order the research insists on. */
function newestFirst(a: RankedTask, b: RankedTask): number {
  return b.record.finished_at.localeCompare(a.record.finished_at) || a.record.id.localeCompare(b.record.id);
}

export function rankTaskRecords(records: readonly TaskRecord[], query: RankingQuery, ctx: RankingContext, weights: Readonly<RankingWeights> = DEFAULT_WEIGHTS): RankedTask[] {
  const ranked: RankedTask[] = [];
  for (const record of records) {
    const r = rankTaskRecord(record, query, ctx, weights);
    if (r) ranked.push(r);
  }
  return ranked.sort((a, b) => (b.score - a.score) || newestFirst(a, b));
}

/** Jaccard over files ∪ record ids: the similarity MMR penalizes. */
export function taskSimilarity(a: TaskRecord, b: TaskRecord): number {
  const sa = new Set([...recordFiles(a), ...recordIdsOf(a)]);
  const sb = new Set([...recordFiles(b), ...recordIdsOf(b)]);
  if (!sa.size && !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Slots: latest on the exact file, most recent problem, then relevant by MMR. */
export function selectTaskSlots(ranked: readonly RankedTask[], options: SlotOptions = {}): TaskSelection {
  const limit = Math.max(1, options.limit ?? 5);
  const relevantMax = Math.max(0, options.relevant ?? 3);
  const lambda = options.lambda ?? 0.7;
  const picks: SlotPick[] = [];
  const taken = new Set<string>();
  const take = (slot: SlotName, r: RankedTask) => { picks.push({ slot, ranked: r }); taken.add(r.record.id); };

  const latest = [...ranked].filter((r) => r.exactFile).sort(newestFirst)[0];
  if (latest) take("latest", latest);
  const violation = [...ranked].filter((r) => r.problem && !taken.has(r.record.id)).sort(newestFirst)[0];
  if (violation && picks.length < limit) take("violation", violation);

  let remaining = ranked.filter((r) => !taken.has(r.record.id));
  while (picks.length < limit && picks.length - (latest ? 1 : 0) - (violation ? 1 : 0) < relevantMax && remaining.length) {
    let best: RankedTask | null = null, bestValue = -Infinity;
    for (const r of remaining) {
      const redundancy = picks.length ? Math.max(...picks.map((p) => taskSimilarity(p.ranked.record, r.record))) : 0;
      const value = lambda * r.score - (1 - lambda) * redundancy;
      if (value > bestValue || (value === bestValue && best && newestFirst(r, best) < 0)) { best = r; bestValue = value; }
    }
    if (!best) break;
    take("relevant", best);
    remaining = remaining.filter((r) => r !== best);
  }
  return { picks, more: ranked.length - picks.length, candidates: ranked.length, mode: "ranked" };
}
