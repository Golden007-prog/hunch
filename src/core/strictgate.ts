/** The hardened gate for `hunch check --strict` (and the strict pre-commit hook):
 *  which invariants may actually FAIL a commit. Extracted + pure so the rule lives
 *  in one audited, unit-tested place (mirrors hookpolicy.ts).
 *
 *  A commit is only ever blocked by a DIRECTLY-scoped, high-confidence, NON-STALE
 *  blocking invariant — never by a blast-radius ("near") guess, nor by a record the
 *  graph may have gone stale on, nor by a low-confidence auto-derived guess. Those
 *  weaker signals still print, as advisory. This makes strict mode safe to enable
 *  on a shared repo: a false positive downgrades to a warning instead of wrongly
 *  failing a teammate's commit. */
export const STRICT_MIN_CONFIDENCE = 0.8;

export interface StrictConstraint {
  severity?: string;
  provenance?: { confidence?: number; source?: string };
}

/** May this invariant FAIL a commit under --strict? Requires blocking severity,
 *  a fresh (non-stale) record, and either high provenance confidence or a
 *  human-confirmed source (a person vouched for it). Near/blast-radius hits never
 *  reach here — the caller passes only directly-scoped invariants. */
export function isStrictBlocker(c: StrictConstraint, stale: boolean): boolean {
  if (c.severity !== "blocking") return false;
  if (stale) return false;
  const confidence = c.provenance?.confidence ?? 0;
  return confidence >= STRICT_MIN_CONFIDENCE || c.provenance?.source === "human_confirmed";
}
