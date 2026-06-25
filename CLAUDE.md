# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hunch is an **Engineering Memory OS**: a CLI + MCP server that builds a persistent, git-native reasoning graph (decisions, bugs, constraints, components) over a codebase and surfaces it to coding assistants. Published as `@davesheffer/hunch` (`hunch` binary). Pure TypeScript ESM, Node ≥20, no build step at dev time (run via `tsx`).

## Commands

```bash
npm run dev -- <args>        # run the CLI from source via tsx (e.g. npm run dev -- doctor)
npm run hunch -- <args>      # alias for the above
npm run build                # clean + tsc -> dist/ (the published artifact; bin = dist/cli/index.js)
npm run typecheck            # tsc --noEmit
npm test                     # tsx --test over test/*.test.ts
tsx --test test/check.test.ts   # run a single test file
```

There is no separate lint step; `typecheck` (strict `tsc`) is the gate. The `site/` and `vscode-extension/` dirs are independent sub-projects with their own tooling.

## Architecture

Data flows: **events → extract → synthesize → store → ground**. Source of truth is git-tracked JSON in `.hunch/`; SQLite (`better-sqlite3`) is a derived FTS5 + graph + vector index, never authoritative.

- `src/cli/index.ts` — Commander entry point; defines every subcommand (`init`, `index`, `backfill`, `sync`, `query`, `why`, `check`, `ci`, `hook`, `mcp`, `migrate`, `compact`, `doctor`, etc.). `src/cli/invocation.ts` holds shared command logic.
- `src/extractors/` — deterministic, no-LLM layer: tree-sitter parsing (`parse.ts`), diff analysis, git history, test-report parsing, and `indexer.ts` which builds the symbol/dependency/component graph.
- `src/synthesis/` — turns a commit/diff into a structured Decision. Runs an external coding-assistant CLI (`claude`/`codex`/`cursor-agent`) on the user's **subscription**; falls back to a deterministic heuristic. `provider.ts` does detection.
- `src/store/` — `jsonStore.ts` (JSON source of truth, atomic writes), `db.ts`/`schema.ts` (SQLite index), `embedder.ts` (optional local embeddings via the optional `@huggingface/transformers` peer dep), `merge.ts`/`compact.ts`.
- `src/core/` — `types.ts` + Zod schemas, `migrate.ts` (forward-migration before validation), `io.ts` (atomic file IO), `hookpolicy.ts`/`strictgate.ts` (the Claude Code edit-hook gate), `checkreport.ts` (constraint-check output).
- `src/mcp/server.ts` — MCP server (`hunch mcp`) exposing the `hunch_*` tools; must stay client-agnostic.
- `src/integrations/` — writers that wire Hunch into a repo: `scaffold.ts`, `providers.ts`, `hooks.ts` (git post-commit), `claudemd.ts` (regenerates the auto block below), `ciAction.ts` (CI Constraint Guard), `mergeDriver.ts`, `gitignore.ts`.

This repo's engineering memory (decisions, bug history, enforced invariants) is kept in a **private overlay**, not published in this public repo — so the auto-generated section below shows no records here. Maintainers with the overlay configured (`hunch private`) see the full graph via the `hunch_*` MCP tools, and `hunch check` / the CI guard still enforce the private invariants locally.

<!-- HUNCH:START — auto-generated, do not edit by hand -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch** — a curated graph of *why* the code is the way it is (decisions, bug history, invariants). It currently holds **0 decisions, 0 bugs, 0 constraints, 10 components**.

**Before reasoning about or editing this codebase, consult Hunch via the `hunch_*` MCP tools:**
- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints).
- `hunch_check_constraints(scope)` — invariants you must not break. **Always run before editing.**
- `hunch_get_dependents(symbol)` — blast radius before a change.
- `hunch_bug_lineage(symptom_or_symbol)` — has this bug happened before? what was the root cause?
- `hunch_query(query)` — free-text search across all of Hunch.
- `hunch_runbook(task)` — the proven steps for a recurring task (e.g. "add an MCP tool", "cut a release").
- `hunch_compare(candidates)` — rank N candidate branches/commits by architectural fit (fewest invariant hits).
- `hunch_record_decision(...)` — write back a decision after a non-trivial choice.

_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
