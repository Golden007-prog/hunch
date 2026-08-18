import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { exportMadrCorpus, MADR_EXPORT_MARKER } from "../src/integrations/madrExport.js";
import {
  buildMadrManifest,
  computeMadrDrift,
  readMadrManifest,
  refreshMadrCorpus,
  writeMadrManifest,
} from "../src/integrations/madrManifest.js";

function dec(partial: Partial<Decision> & { id: string; title: string }): Decision {
  return {
    topic: null,
    status: "accepted",
    context: "",
    decision: "",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    date: "2024-01-01T00:00:00.000Z",
    ...partial,
  } as Decision;
}

const DIR = "docs/adr";
const NOW = "2026-08-18T00:00:00.000Z";

/** A repo root with an exported corpus and its manifest — the adopted state. */
function adoptedRepo(decisions: readonly Decision[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "madrdrift-"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  mkdirSync(join(root, DIR), { recursive: true });
  const { files } = exportMadrCorpus(decisions, DIR);
  for (const f of files) writeFileSync(join(root, DIR, f.name), f.text);
  writeMadrManifest(root, buildMadrManifest(DIR, files, NOW));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const A = dec({ id: "dec_aaaaaaaaaa", title: "Use Postgres", decision: "Relational fits.", valid_from: "2024-01-01T00:00:00.000Z" });
const B = dec({ id: "dec_bbbbbbbbbb", title: "Bind loopback only", decision: "SSH is the boundary.", valid_from: "2024-02-01T00:00:00.000Z" });

test("a repo that never exported sees no MADR drift at all", () => {
  const root = mkdtempSync(join(tmpdir(), "madrdrift-"));
  try {
    assert.deepEqual(computeMadrDrift([A, B], root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a freshly exported corpus is clean", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    assert.deepEqual(computeMadrDrift([A, B], root), []);
  } finally {
    cleanup();
  }
});

test("madr-stale fires when the decision changed since export", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const moved = { ...A, decision: "Relational fits, and we already run it." } as Decision;
    const findings = computeMadrDrift([moved, B], root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "madr-stale");
    assert.match(findings[0]!.detail, /dec_aaaaaaaaaa changed since export/);
  } finally {
    cleanup();
  }
});

test("madr-stale fires when a generated file is deleted from disk", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const name = Object.keys(readMadrManifest(root)!.files)[0]!;
    rmSync(join(root, DIR, name));
    const findings = computeMadrDrift([A, B], root);
    assert.equal(findings.filter((f) => f.kind === "madr-stale" && /missing/.test(f.detail)).length, 1);
  } finally {
    cleanup();
  }
});

test("madr-edited fires when a generated file is hand-edited, and names the decision", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const name = Object.keys(readMadrManifest(root)!.files)[0]!;
    const abs = join(root, DIR, name);
    writeFileSync(abs, readFileSync(abs, "utf8") + "\nA human wrote this line.\n");
    const findings = computeMadrDrift([A, B], root);
    const edited = findings.filter((f) => f.kind === "madr-edited");
    assert.equal(edited.length, 1);
    assert.match(edited[0]!.detail, /hand-edited/);
    assert.match(edited[0]!.detail, /dec_/);
  } finally {
    cleanup();
  }
});

test("removing the generated marker adopts the file — no edited finding, forever", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const name = Object.keys(readMadrManifest(root)!.files)[0]!;
    const abs = join(root, DIR, name);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(MADR_EXPORT_MARKER, "") + "\nMine now.\n");
    assert.deepEqual(computeMadrDrift([A, B], root).filter((f) => f.kind === "madr-edited"), []);
  } finally {
    cleanup();
  }
});

test("madr-orphan fires when a decision leaves the public graph", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    // B moved to the overlay (or was deleted): its public artifact is now orphaned.
    const findings = computeMadrDrift([A], root);
    const orphan = findings.filter((f) => f.kind === "madr-orphan");
    assert.equal(orphan.length, 1);
    assert.match(orphan[0]!.detail, /dec_bbbbbbbbbb/);
    assert.match(orphan[0]!.detail, /overlay/);
  } finally {
    cleanup();
  }
});

test("a new public decision with no ADR is reported once, not per decision", () => {
  const { root, cleanup } = adoptedRepo([A]);
  try {
    const findings = computeMadrDrift([A, B], root);
    const stale = findings.filter((f) => f.kind === "madr-stale");
    assert.equal(stale.length, 1);
    assert.match(stale[0]!.detail, /1 public decision\(s\) have no ADR/);
  } finally {
    cleanup();
  }
});

// ---- the automatic half ---------------------------------------------------

test("refresh is a no-op where no corpus was ever adopted", () => {
  const root = mkdtempSync(join(tmpdir(), "madrdrift-"));
  try {
    assert.equal(refreshMadrCorpus([A, B], root, NOW), null);
    assert.equal(existsSync(join(root, DIR)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh brings a stale corpus back to clean without any user action", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const moved = { ...A, decision: "Relational fits, and we already run it." } as Decision;
    assert.ok(computeMadrDrift([moved, B], root).length > 0, "precondition: drift exists");

    const result = refreshMadrCorpus([moved, B], root, NOW)!;
    assert.equal(result.written, 1);
    assert.deepEqual(computeMadrDrift([moved, B], root), []);
  } finally {
    cleanup();
  }
});

test("refresh never clobbers a hand-edited file, and keeps reporting it", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const name = Object.keys(readMadrManifest(root)!.files)[0]!;
    const abs = join(root, DIR, name);
    const edited = readFileSync(abs, "utf8") + "\nA human wrote this line.\n";
    writeFileSync(abs, edited);

    const result = refreshMadrCorpus([A, B], root, NOW)!;
    assert.deepEqual(result.skippedEdited, [name]);
    assert.equal(readFileSync(abs, "utf8"), edited, "the human's edit survived");

    // And it is still reported after the refresh — not silently forgotten.
    assert.equal(computeMadrDrift([A, B], root).filter((f) => f.kind === "madr-edited").length, 1);
  } finally {
    cleanup();
  }
});

test("refresh removes the artifact of a decision that left the public graph", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const before = readdirSync(join(root, DIR)).length;
    refreshMadrCorpus([A], root, NOW);
    assert.equal(readdirSync(join(root, DIR)).length, before - 1);
    assert.deepEqual(computeMadrDrift([A], root), []);
  } finally {
    cleanup();
  }
});

test("refresh never touches a hand-written ADR sharing the directory", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const mine = join(root, DIR, "0999-hand-written.md");
    writeFileSync(mine, "---\nstatus: accepted\n---\n\n# Mine\n");
    refreshMadrCorpus([A], root, NOW);
    assert.equal(existsSync(mine), true);
    assert.equal(readFileSync(mine, "utf8"), "---\nstatus: accepted\n---\n\n# Mine\n");
  } finally {
    cleanup();
  }
});

test("a second refresh with an unchanged graph writes nothing", () => {
  const { root, cleanup } = adoptedRepo([A, B]);
  try {
    const result = refreshMadrCorpus([A, B], root, NOW)!;
    assert.equal(result.written, 0);
    assert.equal(result.removed, 0);
  } finally {
    cleanup();
  }
});
