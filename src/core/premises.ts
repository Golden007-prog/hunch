/**
 * Premise decay — the doc≠graph / code≠graph family gains a third spoke:
 * WORLD≠graph. A decision's staleness signal today is code drift; but decisions
 * also die when the REASON under them stops being true while the code and docs
 * stay perfectly in sync ("we had no gateway auth", "no ops team yet"). This
 * module evaluates the checkable premises a decision records and turns dead
 * ones into inline escalations.
 *
 * Hard rules (red-teamed by design):
 *   - A dead premise NEVER changes authority. Gates keep gating until a human
 *     re-attests, supersedes, or retires — a self-relaxing gate is a gate the
 *     actor it guards against can disarm by changing the world.
 *   - Cannot-evaluate is NEVER "holds" (the fail-open lesson, dec-recorded in
 *     v1.10.2): an unevaluable check fails and surfaces, so a typo'd premise
 *     reaches a human instead of silently vouching.
 *   - Recorded reasons only: the system cannot notice the premise nobody wrote
 *     down, so callers must present premises as "conditioned on [these]",
 *     never "verified valid".
 *
 * Pure: the clock and the existence probe are injected, so the CLI, drift, and
 * the MCP surfaces share one semantics and tests need no filesystem.
 */
import type { Decision, Premise } from "./types.js";
import { isLive } from "./topics.js";
import type { Escalation } from "./escalations.js";

export interface PremiseEnv {
  /** ISO instant "now" (injected — never read the clock here). */
  now: string;
  /** Repo-relative existence probe. */
  exists(relPath: string): boolean;
}

export interface PremiseVerdict {
  claim: string;
  holds: boolean;
  reason: string;
}

const clip = (s: string, n = 90): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Repo-relative only — a premise check is not an escape hatch into arbitrary
 *  local files (same containment rule as private doc references). */
function validRel(p: string): boolean {
  return !!p && !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes("..");
}

function checkPath(claim: string, rel: string, wantExists: boolean, env: PremiseEnv, under?: string): PremiseVerdict {
  if (!validRel(rel)) {
    return { claim, holds: false, reason: `unevaluable: path must be repo-relative ("${rel}") — fix the premise record` };
  }
  const exists = env.exists(rel);
  if (wantExists) {
    return exists
      ? { claim, holds: true, reason: `"${rel}" still exists` }
      : { claim, holds: false, reason: `"${rel}" no longer exists` };
  }
  // NEGATIVE probe. A missing path proves nothing on its own: a deleted subtree, a
  // renamed directory and a typo all read as "absent". The `under` anchor is what makes
  // the answer mean something — when the ancestor is gone, the question no longer has a
  // subject, so the premise is UNEVALUABLE rather than quietly satisfied. That is the
  // decay this closes: it is what rotted five decisions pointing into vscode-extension/
  // after that tree was cut.
  if (under !== undefined) {
    if (!validRel(under)) {
      return { claim, holds: false, reason: `unevaluable: under must be repo-relative ("${under}") — fix the premise record` };
    }
    if (!env.exists(under)) {
      return { claim, holds: false, reason: `unevaluable: the anchor "${under}" no longer exists, so "${rel}" being absent proves nothing — re-anchor or supersede` };
    }
  }
  return exists
    ? { claim, holds: false, reason: `"${rel}" now exists` }
    // The residual risk is stated, not hidden: a MISTYPED path is also absent, and it
    // stays absent forever — the harm is a premise that silently never fires, which no
    // existence probe can detect. Saying so is what keeps "holds" honest.
    : { claim, holds: true, reason: `"${rel}" still absent${under ? ` under "${under}"` : ""} (a mistyped path also reads as absent — confirm it on re-attest)` };
}

function checkOne(p: Premise, env: PremiseEnv): PremiseVerdict {
  // The clock is an INJECTED input, so it is an unevaluable case like any other.
  // `Date.parse("nope")` is NaN, and `NaN > due` is false — which fell through to
  // "attested until …", i.e. HOLDS. The module's hard rule ("cannot-evaluate is
  // never holds") was enforced for a bad review_by but not for a bad now, and the
  // unenforced half is the one a future caller can get wrong. Checked once, here,
  // so it covers every check kind rather than only the dated one.
  if (!Number.isFinite(Date.parse(env.now))) {
    return { claim: p.claim, holds: false, reason: `unevaluable: caller supplied a non-ISO clock ("${env.now}")` };
  }
  if (p.path_absent !== undefined) return checkPath(p.claim, p.path_absent, false, env, p.under);
  if (p.path_exists !== undefined) return checkPath(p.claim, p.path_exists, true, env);
  if (p.review_by !== undefined) {
    const due = Date.parse(p.review_by);
    if (!Number.isFinite(due)) {
      return { claim: p.claim, holds: false, reason: `unevaluable: review_by is not a date ("${p.review_by}") — fix the premise record` };
    }
    if (Date.parse(env.now) > due) {
      const attested = p.attested ? ` (last attested ${p.attested.slice(0, 10)})` : "";
      return { claim: p.claim, holds: false, reason: `attestation expired ${p.review_by.slice(0, 10)}${attested} — needs a human re-attest` };
    }
    return { claim: p.claim, holds: true, reason: `attested until ${p.review_by.slice(0, 10)}` };
  }
  // Claim-only: documents the reason, can never fire. Deliberately allowed —
  // an honest unwatchable premise beats a fake check.
  return { claim: p.claim, holds: true, reason: "documented only (no check attached)" };
}

/** Evaluate every recorded premise of one decision. Empty when none recorded. */
export function evaluatePremises(d: Decision, env: PremiseEnv): PremiseVerdict[] {
  return (d.premises ?? []).map((p) => checkOne(p, env));
}

/** One inline escalation per LIVE decision with ≥1 dead premise — the question
 *  a human must answer, framed with its resolution verbs. Rejected alternatives
 *  are MENTIONED (count only), never re-litigated into agent context: reopening
 *  a settled rejection is a human call, and consistency alone is a valid reason
 *  to keep a decision whose original premise died. */
export function premiseEscalations(decisions: readonly Decision[], env: PremiseEnv): Escalation[] {
  const out: Escalation[] = [];
  for (const d of decisions) {
    if (!isLive(d) || !d.premises?.length) continue;
    const dead = evaluatePremises(d, env).filter((v) => !v.holds);
    if (!dead.length) continue;
    const rejected = d.alternatives_rejected.length;
    out.push({
      kind: "premise-stale",
      topic: d.topic ?? d.id,
      decisionIds: [d.id],
      question: `Decision "${clip(d.title)}" (${d.id}) rests on ${dead.length} premise(s) that no longer hold — is it still right?`,
      detail: dead.map((v) => `"${clip(v.claim, 80)}" — ${v.reason}`).join("  ·  ")
        + (rejected ? `  ·  ${rejected} rejected alternative(s) on record — reopening them is your call, and keeping the decision for consistency is a valid answer` : ""),
      resolution: "re-attest (update the premise's review_by/attested), supersede via /capture, or retire the decision — its authority is UNCHANGED until you decide.",
    });
  }
  return out;
}
