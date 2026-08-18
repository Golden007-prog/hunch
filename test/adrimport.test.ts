import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdrMarkdown, mapAdrCorpus, adrDecisionId, ADR_FILE_RE } from "../src/extractors/adrImport.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const MADR_ACCEPTED = `---
status: accepted
date: 2024-03-01
deciders: alice, bob
---

# Use PostgreSQL for persistence

## Context and Problem Statement

We need a durable relational store for orders.

## Considered Options

- PostgreSQL
- MongoDB
- SQLite

## Decision Outcome

Chosen option: "PostgreSQL", because it fits the relational model and the team knows it.

### Consequences

- Good, because transactions are first-class
- Bad, because ops now runs a stateful service
`;

const NYGARD_SUPERSEDED = `# 2. Store sessions in Redis

## Status

Superseded by [ADR-0004](0004-store-sessions-in-postgres.md)

## Context

Sessions were in-memory and lost on restart.

## Decision

Store sessions in Redis with a 24h TTL.

## Consequences

Redis becomes a hard runtime dependency.
`;

const NYGARD_SUCCESSOR = `---
date: 2024-06-01
---

# 4. Store sessions in Postgres

## Status

Accepted

## Context

Redis was our only stateful non-relational service.

## Decision

Move session storage into the existing Postgres.

## Consequences

One fewer service to operate.
`;

const MADR_REJECTED = `---
status: rejected
date: 2024-05-10
---

# Adopt a service mesh

## Context and Problem Statement

Cross-service auth was hand-rolled per service.

## Decision Outcome

Rejected: the operational cost outweighs the benefit at three services.
`;

test("parseAdrMarkdown reads MADR frontmatter, options, chosen option, nested consequences", () => {
  const p = parseAdrMarkdown(MADR_ACCEPTED, "docs/adr/0001-use-postgresql.md")!;
  assert.ok(p, "did not parse");
  assert.equal(p.number, 1);
  assert.equal(p.slug, "use-postgresql");
  assert.equal(p.title, "Use PostgreSQL for persistence");
  assert.equal(p.status, "accepted");
  assert.equal(p.date, "2024-03-01");
  assert.match(p.context, /durable relational store/);
  assert.deepEqual(p.consideredOptions, ["PostgreSQL", "MongoDB", "SQLite"]);
  assert.equal(p.chosenOption, "PostgreSQL");
  assert.equal(p.consequences.length, 2);
  assert.match(p.consequences[0]!, /transactions are first-class/);
});

test("parseAdrMarkdown reads Nygard headings, strips the numbered title, extracts the supersede link", () => {
  const p = parseAdrMarkdown(NYGARD_SUPERSEDED, "doc/adr/0002-store-sessions-in-redis.md")!;
  assert.equal(p.title, "Store sessions in Redis");
  assert.equal(p.status, "superseded");
  assert.deepEqual(p.supersededByNumbers, [4]);
  assert.match(p.decision, /24h TTL/);
  assert.deepEqual(p.consequences, ["Redis becomes a hard runtime dependency."]);
});

test("template and index filenames never match the ADR pattern", () => {
  for (const name of ["adr-template.md", "README.md", "index.md", "template.md"]) {
    assert.equal(ADR_FILE_RE.test(name), false, `${name} must not import`);
  }
  assert.equal(parseAdrMarkdown("# X", "docs/adr/README.md"), null);
});

test("mapAdrCorpus closes the superseded window and sets both pointers from a one-sided link", () => {
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
    { relPath: "doc/adr/0004-store-sessions-in-postgres.md", text: NYGARD_SUCCESSOR },
  ]);
  assert.equal(warnings.length, 0, warnings.join("; "));
  const redis = decisions.find((d) => d.related_files[0]!.includes("0002"))!;
  const pg = decisions.find((d) => d.related_files[0]!.includes("0004"))!;
  assert.equal(redis.status, "superseded");
  assert.equal(redis.superseded_by, pg.id);
  assert.equal(pg.supersedes, redis.id, "successor gains the supersedes pointer from the one-sided link");
  assert.equal(redis.valid_to, "2024-06-01", "window closes at the successor's date");
  assert.equal(pg.status, "accepted");
  assert.equal(pg.valid_to, null);
});

test("a superseded ADR with no dates anywhere keeps an OPEN window (migration precedent: never fabricate an instant)", () => {
  const undatedSuccessor = NYGARD_SUCCESSOR.replace(/^---\r?\ndate: 2024-06-01\r?\n---\r?\n/, "");
  const { decisions } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
    { relPath: "doc/adr/0004-store-sessions-in-postgres.md", text: undatedSuccessor },
  ]);
  const redis = decisions.find((d) => d.related_files[0]!.includes("0002"))!;
  assert.equal(redis.status, "superseded", "status carries the truth");
  assert.equal(redis.valid_to, null, "no instant is invented");
});

test("mapAdrCorpus maps rejected status, namespaced topics, alternatives minus chosen, provenance", () => {
  const { decisions } = mapAdrCorpus([
    { relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED },
    { relPath: "docs/adr/0003-adopt-a-service-mesh.md", text: MADR_REJECTED },
  ]);
  const pg = decisions.find((d) => d.title.includes("PostgreSQL"))!;
  assert.equal(pg.topic, "adr.use-postgresql");
  assert.deepEqual(pg.alternatives_rejected, ["MongoDB", "SQLite"], "chosen option excluded");
  assert.equal(pg.valid_from, "2024-03-01");
  assert.equal(pg.provenance.source, "imported:madr");
  assert.deepEqual(pg.provenance.evidence[0], "docs/adr/0001-use-postgresql.md");
  const mesh = decisions.find((d) => d.title.includes("service mesh"))!;
  assert.equal(mesh.status, "rejected");
});

test("mapAdrCorpus warns on out-of-corpus supersede references instead of guessing ids", () => {
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
  ]);
  assert.equal(decisions[0]!.superseded_by, null, "no fabricated id");
  assert.equal(decisions[0]!.status, "superseded", "status still honest");
  assert.ok(warnings.some((w) => w.includes("ADR 4")), warnings.join("; "));
});

test("mapAdrCorpus keeps at most one live decision per topic (highest ADR number wins)", () => {
  const a = MADR_ACCEPTED;
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "docs/adr/0001-use-postgresql.md", text: a },
    { relPath: "docs/adr/0005-use-postgresql.md", text: a },
  ]);
  const live = decisions.filter((d) => d.status === "accepted");
  assert.equal(live.length, 1);
  assert.ok(live[0]!.related_files[0]!.includes("0005"));
  const closed = decisions.find((d) => d.status === "superseded")!;
  assert.equal(closed.superseded_by, live[0]!.id);
  assert.ok(warnings.some((w) => w.includes("two live ADRs")));
});

test("ids derive from the file path, so re-import updates instead of duplicating", () => {
  assert.equal(adrDecisionId("docs/adr/0001-x.md"), adrDecisionId("docs/adr/0001-x.md"));
  const root = mkdtempSync(join(tmpdir(), "hunch-adr-"));
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-use-postgresql.md"), MADR_ACCEPTED);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const first = mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED }]);
  for (const d of first.decisions) store.putCapture("decisions", d);
  const second = mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED }]);
  for (const d of second.decisions) store.putCapture("decisions", d);
  assert.equal(store.json.loadAll("decisions").length, 1, "re-import is an update, not a duplicate");
  store.close();
  rmSync(root, { recursive: true, force: true });
});
