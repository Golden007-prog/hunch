/**
 * Deterministic DRAFT-tripwire scaffolding for the Veto Guard (tier 6). Both the
 * capture path (synthesize.ts) and `hunch veto backfill` use this to turn a
 * decision's `alternatives_rejected` prose into machine-checkable tripwires —
 * always `llm_draft`, so they are ADVISORY ONLY until a human confirms them
 * (dec_a466655539). The LLM may later enrich the same shape; this is the no-LLM
 * floor that keeps the feature useful offline.
 */
import { existsSync, readFileSync } from "node:fs";
import type { RejectedTripwire } from "../core/types.js";

/** Scaffold one draft tripwire per rejected alternative. Scope = directory globs of
 *  the decision's related files. `forbids` is best-effort from the prose: known repo
 *  dependencies named in the text, plus backticked identifiers as candidate symbols.
 *  Empty `forbids` is fine — the tripwire is then inert until a human fills it in. */
export function draftTripwires(alternatives: string[], relatedFiles: string[], knownDeps: string[]): RejectedTripwire[] {
  const scope = dirGlobs(relatedFiles);
  return alternatives.map((alt) => ({
    alternative: alt,
    scope,
    forbids: {
      deps: knownDeps.filter((dep) => mentions(alt, dep)),
      symbols: [...alt.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]!),
      patterns: [],
    },
    provenance: { source: "llm_draft", confidence: 0.5, evidence: [] },
  }));
}

/** External dependency names declared in the repo's package.json (every section),
 *  used to recognise a dep named in a rejected-alternative sentence. */
export function knownRepoDeps(root: string): string[] {
  const p = `${root}/package.json`;
  if (!existsSync(p)) return [];
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as Record<string, Record<string, string> | undefined>;
    return Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
  } catch {
    return []; // unparseable package.json → no auto-deps, never throw
  }
}

/** Whole-token match of a dep name in prose (handles scoped/hyphenated names like
 *  `node-fetch` or `@scope/pkg` without matching inside a larger word). */
function mentions(text: string, dep: string): boolean {
  return new RegExp(`(^|[^\\w@/-])${escapeRe(dep)}([^\\w@/-]|$)`).test(text);
}

function dirGlobs(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const i = f.lastIndexOf("/");
    if (i > 0) set.add(`${f.slice(0, i)}/**`);
  }
  return [...set];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
