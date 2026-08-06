/** Thin wrapper around node:sqlite for the derived index. */
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { FTS_SEARCH_SCHEMA_SQL, PLAIN_SEARCH_SCHEMA_SQL, SCHEMA_SQL } from "./schema.js";

/** Load node:sqlite while swallowing ONLY its ExperimentalWarning (Node 22–24 still
 *  emits it on module load). Hunch's stderr reaches humans, hooks, and MCP clients on
 *  every invocation, so the noise would land everywhere; all other warnings pass through. */
function loadSqlite(): typeof import("node:sqlite") {
  const require = createRequire(import.meta.url);
  const realEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    (realEmit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = realEmit;
  }
}

const sqlite = loadSqlite();

export type DB = import("node:sqlite").DatabaseSync;

type SearchTableKind = "fts5" | "plain" | null;

class RebuildDerivedIndex extends Error {}

function hasFts5(db: DB): boolean {
  try {
    const row = db.prepare(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`).get() as { enabled?: number };
    return Number(row.enabled) === 1;
  } catch {
    return false;
  }
}

function searchTableKind(db: DB): SearchTableKind {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search'`,
  ).get() as { sql?: string } | undefined;
  if (!row) return null;
  return /\bVIRTUAL\s+TABLE\b/i.test(row.sql ?? "") ? "fts5" : "plain";
}

function initializeSchema(db: DB, forcePlainSearch = false): void {
  db.exec(SCHEMA_SQL);
  const wanted: Exclude<SearchTableKind, null> = !forcePlainSearch && hasFts5(db) ? "fts5" : "plain";
  const current = searchTableKind(db);

  // Moving from a portable cache back to an FTS5-capable runtime is cheap: the
  // search table is derived and reindex() repopulates it immediately.
  if (wanted === "fts5" && current === "plain") db.exec("DROP TABLE search");

  // SQLite cannot DROP an FTS virtual table if this runtime does not know the
  // module. The entire database is derived from Git-native JSON, so openDb()
  // safely rebuilds that cache instead of leaving Hunch unusable.
  if (wanted === "plain" && current === "fts5") throw new RebuildDerivedIndex();

  db.exec(wanted === "fts5" ? FTS_SEARCH_SCHEMA_SQL : PLAIN_SEARCH_SCHEMA_SQL);
}

function createDb(sqlitePath: string): DB {
  const db = new sqlite.DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Does this error mean the derived index FILE itself is unusable?
 *
 *  Matched narrowly, on SQLite's own corruption signatures only. An environment failure —
 *  a permission denial, a full disk, a locked file — must still propagate: deleting the
 *  file would not fix it and would destroy a cache the user may still be able to keep.
 *  `SQLITE_CANTOPEN` ("unable to open database file") is deliberately NOT here for that
 *  reason: it usually means a permissions or path problem, not corruption. */
function isCorruptIndexFile(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database disk image is malformed|file is not a database|file is encrypted or is not a database|malformed database schema|database corruption/i.test(message);
}

function discardDerivedIndex(sqlitePath: string): void {
  for (const path of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) rmSync(path, { force: true });
}

export function openDb(sqlitePath: string): DB {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  // A corrupt file can fail at OPEN as well as at schema init (node:sqlite opens lazily,
  // so "file is not a database" typically surfaces on the first statement — but not always).
  let db: DB;
  try {
    db = createDb(sqlitePath);
  } catch (error) {
    if (!isCorruptIndexFile(error)) throw error;
    discardDerivedIndex(sqlitePath);
    db = createDb(sqlitePath);
  }
  try {
    initializeSchema(db);
    return db;
  } catch (error) {
    // The ENTIRE database is derived from the Git-native JSON in .hunch/ — it is a cache,
    // and a cache that cannot be read should be rebuilt, not fatal. That reasoning was
    // already written here, but it was wired to exactly ONE trigger: RebuildDerivedIndex,
    // thrown only when an fts5 index meets a runtime without the FTS5 module. Every other
    // error propagated as a raw SQLite string, so a corrupt file took out `hunch index`,
    // `query`, `check` and `doctor` at once — and, because the pre-edit hook must emit
    // nothing and exit 0 on any failure (con_03a0b94b2e), it also went SILENTLY blind,
    // permanently, with no command left that could repair it.
    if (!(error instanceof RebuildDerivedIndex) && !isCorruptIndexFile(error)) {
      db.close();
      throw error;
    }
    try { db.close(); } catch { /* a corrupt handle may refuse to close; the file goes anyway */ }
    discardDerivedIndex(sqlitePath);
    db = createDb(sqlitePath);
    // Deliberately NOT wrapped in another rebuild attempt: if a freshly created file also
    // fails, the problem is the environment, not the cache, and it must surface.
    initializeSchema(db);
    return db;
  }
}

/** In-memory db (tests / ephemeral queries). */
export function openMemoryDb(options: { forcePlainSearch?: boolean } = {}): DB {
  const db = new sqlite.DatabaseSync(":memory:");
  initializeSchema(db, options.forcePlainSearch);
  return db;
}

/** Run `fn` inside one transaction: BEGIN → fn → COMMIT, ROLLBACK on throw.
 *  (node:sqlite has no better-sqlite3-style transaction() helper.) */
export function withTx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}
