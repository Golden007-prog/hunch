/** Optional CONTENT matcher for a constraint: a regex tested against the lines a
 *  diff/edit ADDS. When a constraint carries one, the gate decides a violation by
 *  CONTENT (the rule was actually broken) instead of by bare SCOPE-touch.
 *
 *  Why this matters: scope-touch enforcement is so blunt that strict had to fail
 *  OPEN once a guarded file changed (the "staleness" gate) or it would block every
 *  edit in scope — which silently retracts the teeth over a file's normal life
 *  (dec_e0a36efbf5). A content match is verifiable PER COMMIT, so it needs no
 *  staleness proxy: a vouched, content-matched invariant keeps blocking the actual
 *  violation across the whole life of the file, and stays quiet on edits that don't
 *  break it. Bad user/LLM regex is compiled defensively and is simply inert. */
export function constraintMatcher(pattern?: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null; // malformed pattern → inert, never throws
  }
}

/** True iff any ADDED line trips the constraint's content matcher. */
export function contentViolates(re: RegExp | null, addedLines: string[]): boolean {
  if (!re) return false;
  return addedLines.some((l) => re.test(l));
}
