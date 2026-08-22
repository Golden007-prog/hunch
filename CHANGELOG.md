# Changelog

## 1.18.1 — 2026-08-22

### Deprecated ADRs no longer invent successors

`hunch import-adr` now distinguishes a bare `deprecated` lifecycle from an explicit replacement.
A named successor still closes the decision window; without one, Hunch keeps the imported record
visible as advisory accepted memory, preserves the raw lifecycle in provenance, and emits a warning
asking for an explicit successor or rejection instead of silently fabricating history.

## 1.18.0 — 2026-08-22

### YAML and Helm enter the graph

YAML anchors are now symbols and aliases are reference edges, so configuration dependencies
participate in blast radius without pretending to be function calls. Helm helper definitions and
`include` / `template` uses are extracted only inside the nearest `Chart.yaml` scope; duplicate
names in separate charts and unrelated languages do not fabricate edges. `.tpl` files and
Helm/Jinja-templated YAML remain indexable before rendering, while invalid ordinary YAML still
fails closed and GitHub Actions `${{ }}` expressions are not mistaken for Helm syntax.

The merge also fixes two graph-integrity seams surfaced by YAML: root-level files now belong to an
exact-file component instead of a repository-wide `./**` glob, and call attribution keys on a
symbol's stable array position so overlapping synthetic YAML/Helm symbols cannot collapse at byte
zero. YAML and Helm support was contributed by Oliver Sampson and reconciled with the current Go,
HLG, and schema-generation contracts before release.

### A repository becomes a versioned landscape fragment

The Engineering Landscape Graph begins as an additive view over the existing source of truth.
Stable kind-qualified resource IDs, directional relationship IDs, lifecycle, credential-free
locators, provenance/currentness, forward migration, and rebuildable SQLite projections now have
an executable contract. The first bounded discovery slice reads an exact Git revision and emits
reviewable package/workspace and canonical Git-remote candidates with field-level evidence; it
does not write authority, retain credentials or local paths, or make Hunch an orchestrator.

Retrieval benchmark floors now run against a disposable fresh graph, publication vocabulary caches
are store-scoped, and effective private/team memory routing is explicit in diagnostics. These close
silent-regression and cross-repository contamination paths without changing enforcement authority.

## 1.17.0 — 2026-08-18

### The projection notices when it rots

Exported ADR corpora can now adopt a content-hash manifest and participate in normal drift and
healing. Hunch distinguishes a decision that moved (`madr-stale`), a generated file changed by a
human (`madr-edited`), and an artifact whose public decision disappeared (`madr-orphan`), with a
separate repair path for each. Adopted corpora refresh during post-commit sync, and edit protection
is keyed by content so renumbering cannot erase a hand edit.

Retrieval also gives recorded intent a bounded ranking prior over code symbols that only share the
query vocabulary. The prior improved the curated Recall@10 result from 70% to 90% and remains
reversible with `HUNCH_MEMORY_PRIOR_SHIFT=0`.

## 1.16.0 — 2026-08-18

### The MADR bridge

`hunch import-adr` deterministically imports MADR and Nygard corpora into the graph, preserving
accepted, superseded, and rejected semantics without duplicating records on rerun. `hunch
export-adr` emits a standard, regenerable MADR projection with Backstage metadata, refuses to
overwrite a hand-written corpus, and excludes private-overlay records. The graph remains the source
of truth.

## 1.15.0 — 2026-08-18

### Go support

Go repositories now enter the same symbol and dependency graph as TypeScript and Python through the
language registry. Structs, interfaces, type specifications, aliases, imports, and package-qualified
calls are indexed conservatively: module paths resolve exact package directories, standard-library
calls are filtered, and ambiguous edges are not invented. Prebuilt grammar support ships across the
supported platform matrix.

## 1.14.0 — 2026-08-18

### Context arrives with its graph neighborhood

Context delivery can walk a bounded, deterministic graph neighborhood with depth decay, node and
token caps, and external-hub exclusion. This raised the curated Recall@10 result from 81.8% to
90.9% without changing the response contract. The release also excludes retired constraints from
grounding, resolves MCP auto-commit roots per call, and fixes unstaged-only release-gate drift.

## 1.13.1 — 2026-08-15

### MCP delivery receipts arrive as structured data

`hunch_context` now advertises an MCP output schema and returns the canonical delivery envelope in
`structuredContent` while preserving the existing text response for older clients. Orchestrators
can consume exact delivered and omitted record IDs, rank, delivery reason, provenance/currentness,
token cost, budget use and blocking overflow without parsing prose.

Every record actually returned by MCP is also appended to the same machine-local served ledger used
by agent hooks. Budget-omitted or stale records are never receipted, and receipt persistence remains
best-effort so telemetry failure cannot block context delivery.

## 1.13.0 — 2026-08-13

### Truthful, provenance-checked delivery envelopes

CLI, MCP, and edit-hook context now share a deterministic ranked headline envelope. It checks
record anchors and decision-commit reachability, withholds definitively stale records, packs to the
requested context budget, and returns the exact delivered IDs used by the machine-local receipt
ledger. Active blocking constraints are never silently discarded when a requested budget is too
small; the envelope reports that exceptional overflow explicitly.

Edit-hook decision, documentation, and retired-code grounding now competes inside that same hard
budget instead of overflowing after packing. Delivery receipts add rank, delivery reason,
provenance/currentness status, and estimated token cost, with an additive migration for existing
machine-local ledgers and the fields available from `hunch served --json`.

## 1.12.2 — 2026-08-12

### Grounding that reliably reaches Windows agents

Generated hook commands now execute correctly under PowerShell, cmd, and sh, and rerunning
`hunch init` replaces the broken form instead of installing a duplicate. Architectural Conformance
also tolerates the exact tagged-template escape shape that TypeScript accepts but the underlying
grammar rejects, without weakening fail-closed handling for real syntax errors.

The release gate now includes public-only memory drift, so it verifies the same graph and grounding
a fresh contributor clone receives. See the [complete release history](https://hunch-pi.vercel.app/changelog)
for v1.12.1 delivery receipts and v1.12.0 delegation/compaction coverage.

## 1.9.0 — 2026-07-22

### One living engineering memory for the whole team

Hunch can now connect a codebase to a dedicated private Git repository that holds the team's
decisions, corrections, constraints, policies, and proofs. Commit the generated
`.hunch/team.json` pointer once; a fresh clone running `hunch init` validates and connects its own
ignored local memory clone, and connected MCP sessions refresh at tool-request boundaries.

Shared captures commit and synchronize automatically by default. Concurrent structured records
merge deterministically, public-only checks exclude the shared graph, and strict checks refuse to
pass on a stale or unverified team route. Corrections can be upgraded into proof-backed proposals,
but those correction proposals remain mechanically non-activatable until source-currentness safety
lands. Other policy types still gain no authority unless a human explicitly accepts them.

Release artifacts now hold the same line. The package and VS Code extension are tested before any
publisher receives credentials, the exact tested bytes are carried forward unchanged, and the
registries are checked after publication. npm releases prove the tagged source across supported
runtimes and Windows/macOS Matrix safety; VS Code v0.17.2 publishes the same VSIX to the Visual
Studio Marketplace and Open VSX.

To move an existing code repository's public Hunch records into the shared store, use
`hunch shared --repo <separate-private-memory-repo> --migrate`. Omit `--migrate` for a new setup.
Upgrade with `npm i -g @davesheffer/hunch@1.9.0`; the documented rollback keeps the memory
repository intact while disabling enforcement and automatic publication before pinning a previous
package version.

The complete release history remains available on the
[Hunch changelog](https://hunch-pi.vercel.app/changelog).
