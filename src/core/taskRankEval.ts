/** Offline evaluation of task-record ranking (dec_66925aa0ee, PR B).
 *
 * Leave-one-out over finished task records: for each task T, rank the tasks
 * that finished before it with a query built from T's own record, and ask
 * whether the records T evidently needed appear in the five slots. Compared
 * against the previous behaviour ("latest 3 on the file") with a paired
 * bootstrap confidence interval. Deterministic: seeded resampling, no clock.
 *
 * Ground truth is what the record itself proves T used: an older task that
 * received or saved a record T applied, that ran the same check T ran on an
 * overlapping file, or whose violated rule T received. This is a proxy, not a
 * label; the metric is pre-registered so the ranker cannot be tuned to it and
 * then evaluated on the same window. */
import { DEFAULT_WEIGHTS, normalizePath, rankTaskRecords, recordIdsOf, selectTaskSlots, type RankingContext, type RankingQuery, type RankingWeights } from "./taskRanking.js";
import type { TaskRecord } from "./types.js";

export const TASK_RANK_EVAL_SCHEMA = "hunch.task-rank-eval/1" as const;
const GENERIC_TITLES: ReadonlySet<string> = new Set(["Assistant task", "Claude task"]);

export interface EvalCase {
  task: TaskRecord;
  file: string;
  older: TaskRecord[];
  truth: Set<string>;
}

export interface RankerScore { name: string; hit5: number; mrr: number; hits: number[] }

export interface RankEvalReport {
  schema: typeof TASK_RANK_EVAL_SCHEMA;
  tasks: number;
  evaluable: number;
  split: { fraction: number; evaluated: number; note: string | null };
  rankers: Array<Omit<RankerScore, "hits">>;
  /** Paired difference ranked − baseline on Hit@5. */
  delta_hit5: { mean: number; ci95: [number, number]; resamples: number };
  verdict: "ranked-better" | "baseline-better" | "inconclusive" | "insufficient-data";
  weights: RankingWeights;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2));
}

/** What T evidently used from older tasks. */
export function groundTruth(task: TaskRecord, older: readonly TaskRecord[]): Set<string> {
  const applied = new Set(task.applied.map((a) => a.record_id));
  const received = new Set(task.lessons.map((l) => l.record_id));
  const labels = new Set(task.checks.map((c) => c.label));
  const files = new Set(task.files.map(normalizePath));
  const truth = new Set<string>();
  for (const o of older) {
    const ids = recordIdsOf(o);
    const overlap = o.files.some((f) => files.has(normalizePath(f)));
    if ([...applied].some((id) => ids.has(id))) { truth.add(o.id); continue; }
    if (overlap && o.checks.some((c) => labels.has(c.label))) { truth.add(o.id); continue; }
    if (o.conformance.some((c) => c.outcome === "violated" && received.has(c.record_id))) { truth.add(o.id); continue; }
  }
  return truth;
}

/** T's own record as the query it would have had before editing. */
export function evalQuery(task: TaskRecord): RankingQuery {
  const files = new Set(task.files.map(normalizePath));
  return {
    target: normalizePath(task.files[0] ?? task.title),
    files,
    recordIds: new Set(task.lessons.map((l) => l.record_id)),
    phrase: GENERIC_TITLES.has(task.title) ? null : task.title,
    now: Date.parse(task.finished_at) || 0,
  };
}

/** A store-free context: IDF over the older set, lexical by token overlap. */
export function pureContext(older: readonly TaskRecord[], query: RankingQuery): RankingContext {
  const df = new Map<string, number>();
  for (const r of older) for (const id of recordIdsOf(r)) df.set(id, (df.get(id) ?? 0) + 1);
  const n = Math.max(1, older.length);
  const lexical = new Map<string, number>();
  if (query.phrase) {
    const q = tokens(query.phrase);
    let best = 0;
    const raw = new Map<string, number>();
    for (const r of older) {
      const doc = tokens(`${r.title} ${r.lessons.map((l) => l.title).join(" ")}`);
      let inter = 0;
      for (const t of q) if (doc.has(t)) inter++;
      const score = q.size ? inter / q.size : 0;
      if (score > 0) { raw.set(r.id, score); best = Math.max(best, score); }
    }
    for (const [id, s] of raw) lexical.set(id, s / best);
  }
  return {
    dependents: new Set(), cochange: new Map(), lexical, anchorsAlive: () => 1,
    ruleStats: (id) => { const d = df.get(id) ?? 0; return { df: d, idf: Math.log((n + 1) / (d + 1)) + 1e-6 }; },
  };
}

export function buildCases(records: readonly TaskRecord[]): EvalCase[] {
  const sorted = [...records].filter((r) => r.state === "completed").sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.id.localeCompare(b.id));
  const cases: EvalCase[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const task = sorted[i]!;
    if (!task.files.length) continue;
    const older = sorted.slice(0, i);
    if (!older.length) continue;
    const truth = groundTruth(task, older);
    if (!truth.size) continue;
    cases.push({ task, file: normalizePath(task.files[0]!), older, truth });
  }
  return cases;
}

export type Ranker = (c: EvalCase) => string[];

export function rankedRanker(weights: Readonly<RankingWeights> = DEFAULT_WEIGHTS): Ranker {
  return (c) => {
    const q = evalQuery(c.task);
    const ranked = rankTaskRecords(c.older, q, pureContext(c.older, q), weights);
    return selectTaskSlots(ranked).picks.map((p) => p.ranked.record.id);
  };
}

export const latest3Ranker: Ranker = (c) =>
  c.older.filter((r) => r.files.map(normalizePath).includes(c.file))
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at) || a.id.localeCompare(b.id))
    .slice(0, 3).map((r) => r.id);

export function scoreRanker(name: string, ranker: Ranker, cases: readonly EvalCase[]): RankerScore {
  const hits: number[] = [];
  let rr = 0;
  for (const c of cases) {
    const picks = ranker(c).slice(0, 5);
    const rank = picks.findIndex((id) => c.truth.has(id));
    hits.push(rank >= 0 ? 1 : 0);
    if (rank >= 0) rr += 1 / (rank + 1);
  }
  const n = cases.length || 1;
  return { name, hit5: hits.reduce((s, h) => s + h, 0) / n, mrr: rr / n, hits };
}

/** xorshift32: deterministic resampling so two runs agree byte for byte. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; };
}

export function pairedBootstrap(a: readonly number[], b: readonly number[], resamples = 1000, seed = 42): { mean: number; ci95: [number, number] } {
  const n = a.length;
  if (!n) return { mean: 0, ci95: [0, 0] };
  const diffs = a.map((x, i) => x - (b[i] ?? 0));
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const rnd = prng(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)]!;
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const at = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * (means.length - 1))))]!;
  return { mean, ci95: [at(0.025), at(0.975)] };
}

export interface RankEvalOptions { split?: number; minEvaluated?: number; resamples?: number; weights?: Readonly<RankingWeights> }

export function evaluateTaskRanking(records: readonly TaskRecord[], options: RankEvalOptions = {}): RankEvalReport {
  const split = options.split ?? 0.3;
  const minEvaluated = options.minEvaluated ?? 5;
  const all = buildCases(records);
  let cases = all.slice(Math.floor(all.length * (1 - split)));
  let note: string | null = null;
  if (cases.length < minEvaluated) { cases = all; note = `fewer than ${minEvaluated} cases in the newest ${Math.round(split * 100)}%; evaluated every case`; }
  const weights = { ...(options.weights ?? DEFAULT_WEIGHTS) };
  const ranked = scoreRanker("ranked", rankedRanker(weights), cases);
  const baseline = scoreRanker("latest3", latest3Ranker, cases);
  const resamples = options.resamples ?? 1000;
  const delta = pairedBootstrap(ranked.hits, baseline.hits, resamples);
  let verdict: RankEvalReport["verdict"] = "inconclusive";
  if (cases.length < minEvaluated) verdict = "insufficient-data";
  else if (delta.ci95[0] > 0) verdict = "ranked-better";
  else if (delta.ci95[1] < 0) verdict = "baseline-better";
  return {
    schema: TASK_RANK_EVAL_SCHEMA,
    tasks: records.length,
    evaluable: all.length,
    split: { fraction: split, evaluated: cases.length, note },
    rankers: [ranked, baseline].map(({ hits: _h, ...rest }) => rest),
    delta_hit5: { ...delta, resamples },
    verdict,
    weights,
  };
}

export function renderRankEval(report: RankEvalReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `Task ranking evaluation — ${report.evaluable} evaluable of ${report.tasks} task record(s); evaluated ${report.split.evaluated}${report.split.note ? ` (${report.split.note})` : ` (newest ${Math.round(report.split.fraction * 100)}%)`}`,
  ];
  for (const r of report.rankers) lines.push(`  ${r.name.padEnd(8)} Hit@5 ${pct(r.hit5).padStart(4)}  MRR ${r.mrr.toFixed(2)}`);
  lines.push(`  Δ Hit@5 ranked − latest3: ${(report.delta_hit5.mean * 100).toFixed(0)} pts, 95% CI [${(report.delta_hit5.ci95[0] * 100).toFixed(0)}, ${(report.delta_hit5.ci95[1] * 100).toFixed(0)}] (${report.delta_hit5.resamples} resamples)`);
  lines.push(`  verdict: ${report.verdict}${report.verdict === "insufficient-data" ? " — keep collecting; the kill rule needs a CI that excludes zero" : ""}`);
  return lines.join("\n");
}
