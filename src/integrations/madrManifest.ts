/**
 * MADR projection freshness — the manifest and the drift it feeds.
 *
 * The export half (madrExport.ts) renders the graph into a disposable MADR
 * corpus. Nothing, until now, noticed when that corpus went stale: the wiki gets
 * `wiki-stale` when its inputs move, but an exported ADR file could sit in
 * `docs/adr/` confidently wrong forever. This closes that seam with the exact
 * mechanism the wiki already proves out — a content-hash manifest, adopted on
 * first export, silent when absent.
 *
 * Two hashes per file, and they answer different questions:
 *   - `hash`  — the decision's projected content. Moves when the GRAPH moves,
 *               so a mismatch means "the projection is behind the graph".
 *   - `bytes` — the file as written. Moves when a HUMAN edits it, so a mismatch
 *               means "someone hand-edited a generated file", which the export
 *               marker warns against but nothing detected.
 *
 * Three findings, matching the three ways a projection can rot:
 *   - madr-stale    the decision changed since export (or the file is gone)
 *   - madr-edited   a generated file was hand-edited; the next export overwrites it
 *   - madr-orphan   a generated file whose decision no longer exists in the graph
 *
 * All advisory, like every other drift kind: this is a smoke detector, not a
 * robot that rewrites the corpus. `hunch export-adr` is the heal.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "../core/types.js";
import type { DriftFinding } from "../core/drift.js";
import { writeFileAtomic } from "../core/io.js";
import { hunchPaths } from "../core/paths.js";
import { toPosixTarget } from "../core/paths.js";
import { exportMadrCorpus, isRegenerableMadr } from "./madrExport.js";

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface MadrManifest {
  version: 1;
  /** repo-relative POSIX dir the corpus was exported to */
  dir: string;
  /** keyed by file name (NNNN-slug.md) — the export assigns numbers per run */
  files: Record<string, { decision: string; hash: string; bytes: string; generated: string }>;
}

export function madrManifestPath(root: string): string {
  return join(hunchPaths(root).hunch, "madr-manifest.json");
}

export function readMadrManifest(root: string): MadrManifest | null {
  try {
    const raw = JSON.parse(readFileSync(madrManifestPath(root), "utf8")) as MadrManifest;
    if (!raw || raw.version !== 1 || typeof raw.dir !== "string" || !raw.files || typeof raw.files !== "object") return null;
    // Drop malformed entries rather than crashing every drift-bearing command,
    // the same tolerance readWikiManifestAt applies to a bad merge.
    raw.files = Object.fromEntries(
      Object.entries(raw.files).filter(
        ([, f]) => f && typeof f === "object" && typeof f.decision === "string" && typeof f.hash === "string",
      ),
    );
    return raw;
  } catch {
    return null;
  }
}

export function writeMadrManifest(root: string, manifest: MadrManifest): void {
  writeFileAtomic(madrManifestPath(root), JSON.stringify(manifest, null, 2) + "\n");
}

/** The projected-content hash for one file. Content, not mtime: a re-export that
 *  changes nothing must not read as drift. */
export const madrContentHash = (text: string): string => sha16(text);

/**
 * Build the manifest for a corpus that was just written.
 *
 * `written` carries the bytes actually placed on disk, which may differ from the
 * rendered text when a file was refused (hand-written corpus in the target dir).
 * Refused files are absent from the manifest, so they are never later reported
 * as edited — they were never ours.
 */
export function buildMadrManifest(
  dir: string,
  entries: ReadonlyArray<{ name: string; text: string; decisionId: string }>,
  generatedAt: string,
): MadrManifest {
  const files: MadrManifest["files"] = {};
  for (const e of entries) {
    files[e.name] = {
      decision: e.decisionId,
      hash: madrContentHash(e.text),
      bytes: sha16(e.text),
      generated: generatedAt,
    };
  }
  return { version: 1, dir: toPosixTarget(dir), files };
}

/**
 * Drift for the MADR projection. Fires ONLY where a manifest exists — a repo that
 * never ran `hunch export-adr` sees zero noise, matching the wiki's rule.
 *
 * Takes the PUBLIC decision list, never the overlay union: the projection is a
 * committable artifact, so its freshness must be computed from exactly the
 * records that are allowed to reach it. Passing the union here would leak the
 * existence of overlay decisions into a public drift report.
 */
export function computeMadrDrift(publicDecisions: readonly Decision[], root: string): DriftFinding[] {
  const manifest = readMadrManifest(root);
  if (!manifest) return []; // never exported → silent
  const findings: DriftFinding[] = [];

  // Re-render from the current graph. Numbering is assigned per export, so a file
  // name is only stable while the decision set is; compare by DECISION id, which
  // is the thing that actually has identity.
  const { files } = exportMadrCorpus(publicDecisions, manifest.dir);
  const currentByDecision = new Map(files.map((f) => [f.decisionId, f] as const));
  const liveIds = new Set(publicDecisions.map((d) => d.id));

  for (const [name, entry] of Object.entries(manifest.files)) {
    const rel = `${manifest.dir}/${name}`;
    const abs = join(root, manifest.dir, name);

    // 1. ORPHAN — the decision left the public graph (deleted, or moved to the
    //    overlay). The file is now a public artifact with no record behind it,
    //    which is the shape of a leak as much as of staleness.
    if (!liveIds.has(entry.decision)) {
      findings.push({
        kind: "madr-orphan",
        id: rel,
        detail: `generated ADR has no decision in the public graph (${entry.decision} is gone or moved to the overlay) — delete it, or re-run \`hunch export-adr\``,
      });
      continue;
    }

    // 2. MISSING — manifested but not on disk.
    if (!existsSync(abs)) {
      findings.push({
        kind: "madr-stale",
        id: rel,
        detail: `generated ADR for ${entry.decision} is missing from ${manifest.dir}/ — regenerate with \`hunch export-adr\``,
      });
      continue;
    }

    let onDisk: string;
    try {
      onDisk = readFileSync(abs, "utf8");
    } catch {
      continue; // unreadable is an environment problem, not memory drift
    }

    // 3. HAND-EDITED — the bytes moved and the marker is still there, so the next
    //    export silently overwrites human work. Report before that happens.
    //    A file whose marker was REMOVED is deliberately not ours any more: the
    //    export already refuses it, and calling that drift would nag forever.
    if (sha16(onDisk) !== entry.bytes && isRegenerableMadr(onDisk)) {
      findings.push({
        kind: "madr-edited",
        id: rel,
        detail: `generated ADR was hand-edited — \`hunch export-adr\` will overwrite it. Move the change into decision ${entry.decision} (\`/capture\`), or drop the hunch:generated marker to adopt the file`,
      });
    }

    // 4. STALE — the graph moved underneath the projection.
    const current = currentByDecision.get(entry.decision);
    if (current && madrContentHash(current.text) !== entry.hash) {
      findings.push({
        kind: "madr-stale",
        id: rel,
        detail: `decision ${entry.decision} changed since export — regenerate with \`hunch export-adr\``,
      });
    }
  }

  // 5. UNEXPORTED — a public decision with no file at all. Only reported once a
  //    corpus exists, so adopting the export does not immediately indict every
  //    decision recorded before it.
  const manifested = new Set(Object.values(manifest.files).map((f) => f.decision));
  const missing = publicDecisions.filter((d) => !manifested.has(d.id));
  if (missing.length) {
    findings.push({
      kind: "madr-stale",
      id: manifest.dir,
      detail: `${missing.length} public decision(s) have no ADR in ${manifest.dir}/ (e.g. ${missing[0]!.id}) — regenerate with \`hunch export-adr\``,
    });
  }

  return findings;
}

/**
 * Keep an adopted corpus fresh automatically.
 *
 * Called from the post-commit sync path (and from any writer that changes the
 * public graph out of band, such as the memory service's HTTP write path), so a
 * user who ran `hunch export-adr` once never has to run it again — the
 * projection tracks the graph the way the SQLite index does.
 *
 * Deliberately narrow:
 *   - No manifest → no-op. Adoption stays an explicit act.
 *   - Refuses to touch a file that was hand-edited, because silently discarding
 *     someone's edit is worse than a stale file; `madr-edited` drift reports it
 *     and the human decides.
 *   - Removes generated files the new numbering dropped, so the corpus stays
 *     internally consistent, but never removes a file it did not generate.
 *
 * Returns what changed so callers can log it; throws nothing the caller must
 * handle — a projection refresh must never take down a commit or an HTTP write.
 */
export interface MadrRefreshResult {
  dir: string;
  written: number;
  removed: number;
  skippedEdited: string[];
}

export function refreshMadrCorpus(
  publicDecisions: readonly Decision[],
  root: string,
  now: string,
): MadrRefreshResult | null {
  const manifest = readMadrManifest(root);
  if (!manifest) return null; // never adopted → stay out of the way

  const { files } = exportMadrCorpus(publicDecisions, manifest.dir);
  const outDir = join(root, manifest.dir);
  if (!existsSync(outDir)) return null; // corpus deleted wholesale; drift reports it

  const skippedEdited: string[] = [];
  const kept: Array<{ name: string; text: string; decisionId: string }> = [];
  /** Manifest entries carried through verbatim (hand-edited files we refused to touch). */
  const preserved = new Map<string, MadrManifest["files"][string]>();
  let written = 0;

  for (const f of files) {
    const abs = join(outDir, f.name);
    const prior = manifest.files[f.name];
    if (existsSync(abs)) {
      let onDisk: string;
      try {
        onDisk = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // Someone else's file, or someone's edit: leave both alone.
      if (!isRegenerableMadr(onDisk)) continue;
      if (prior && sha16(onDisk) !== prior.bytes) {
        skippedEdited.push(f.name);
        // Carry the PRIOR entry through untouched. Rebuilding it from the edited
        // bytes would make the file match its own manifest and the edit would
        // stop being reported — the refresh would quietly launder a hand edit
        // into the record of what we generated.
        preserved.set(f.name, prior);
        continue;
      }
      if (onDisk === f.text) {
        kept.push(f);
        continue; // already current — no write, no churn
      }
    }
    writeFileAtomic(abs, f.text);
    kept.push(f);
    written++;
  }

  // Drop generated files the new numbering no longer produces. Marker-verified,
  // so a hand-written file in the same directory is never touched.
  let removed = 0;
  const produced = new Set(files.map((f) => f.name));
  for (const name of Object.keys(manifest.files)) {
    if (produced.has(name)) continue;
    const abs = join(outDir, name);
    if (!existsSync(abs)) continue;
    try {
      if (isRegenerableMadr(readFileSync(abs, "utf8"))) {
        rmSync(abs);
        removed++;
      }
    } catch { /* best effort */ }
  }

  const next = buildMadrManifest(manifest.dir, kept, now);
  for (const [name, entry] of preserved) next.files[name] = entry;
  writeMadrManifest(root, next);
  return { dir: manifest.dir, written, removed, skippedEdited };
}
