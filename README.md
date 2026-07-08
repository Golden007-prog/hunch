# 🧠 Hunch — Architectural Conformance for AI code

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

> **Your repo remembers *what* changed. Hunch makes it remember *why*** — and keeps every
> AI coding session consistent with the decisions, trade-offs, and bugs you already paid for.
> Local-first, git-native, works with Claude Code, Cursor, Copilot, Windsurf & Codex.

## Install

```bash
npm i -g @davesheffer/hunch
cd your-repo && hunch init      # 2 minutes; advisory by default — nothing blocks until you say so
hunch backfill --since 90d      # optional: seed memory from recent git history
```

Reload your assistant and ask: *"why is X built this way?"* — it answers from the graph, with receipts.

## The moment it earns its keep

An AI "optimizes" your controller to query the DB directly. Linters stay green — no bad
pattern to match. Hunch flags it: *"listOrders now reaches dbQuery · why: the Mar-2025 N+1
incident · protects against bug_0317."* You decide what happens next — advisory shows the
note; **strict** (opt-in) holds the change.

Measured ([`bench/`](bench/architectural-conformance.md), n=90, three models): recorded rules
in context cut architectural drift **58% → 16%**. The deterministic check catches the rest —
no model in the loop.

## What you get

- **Memory as a byproduct of work** — every commit becomes a decision, failing tests become bug lineage; no documentation chore
- **Every answer with receipts** — decisions cite the why, the rejected alternatives, and the bug they protect against
- **Guards that hold the line** — corrections become permanent rules; drift and re-opened bugs get caught deterministically
- **Verification pipeline** (v1.4) — the agent can't end a turn claiming success on unverified edits
- **One graph, every assistant** — plain git-tracked JSON in `.hunch/`, served over MCP; no SaaS, $0, works offline

## Learn more

**[Documentation](https://hunch-pi.vercel.app/docs)** · **[Cookbook](https://hunch-pi.vercel.app/cookbook)** · **[Changelog](https://hunch-pi.vercel.app/changelog)** · **[15-second demo](demo/architectural-conformance.sh)**

Apache-2.0
