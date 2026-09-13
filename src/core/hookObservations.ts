/** Runtime evidence that a host actually delivered a lifecycle event to Hunch's
 * hook. Configuration proves wiring; only an observed event proves delivery.
 * One row per (provider, normalized event), machine-local, outside the
 * rebuildable index. Recording is best-effort: a hook must never fail on it. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withServedDatabase } from "./served.js";
import { HUNCH_VERSION } from "./version.js";

export type HookOutcomeEvidence = "success" | "failure" | "unknown";
export interface HookObservation {
  provider: string;
  event: string;
  at: string;
  version: string;
  /** Present for observations recorded after outcome tracking was added. */
  outcome?: HookOutcomeEvidence | null;
}

type Database = Parameters<Parameters<typeof withServedDatabase>[1]>[0];
function ensureTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hook_observations (
    provider TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, version TEXT NOT NULL,
    outcome TEXT,
    PRIMARY KEY (provider, event)
  )`);
  // Existing machine ledgers predate outcome tracking. Their rows remain
  // intentionally unknown until a later hook delivery supplies a result.
  const columns = db.prepare("PRAGMA table_info(hook_observations)").all() as Array<{ name?: string }>;
  if (!columns.some(column => column.name === "outcome")) db.exec("ALTER TABLE hook_observations ADD COLUMN outcome TEXT");
}

/** Never throws (con_03a0b94b2e): a missing ledger costs evidence, not the edit. */
export function recordHookObservation(root: string, provider: string, event: string, outcome?: HookOutcomeEvidence): void {
  try {
    withServedDatabase(root, db => {
      ensureTable(db);
      const evidence = outcome === "failure" || outcome === "success" ? outcome : null;
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO hook_observations (provider, event, at, version, outcome)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, event) DO UPDATE SET
          at = CASE WHEN excluded.outcome = 'failure' OR hook_observations.outcome IS NULL OR hook_observations.outcome != 'failure' THEN excluded.at ELSE hook_observations.at END,
          version = CASE WHEN excluded.outcome = 'failure' OR hook_observations.outcome IS NULL OR hook_observations.outcome != 'failure' THEN excluded.version ELSE hook_observations.version END,
          outcome = CASE WHEN excluded.outcome = 'failure' OR hook_observations.outcome = 'failure' THEN 'failure' ELSE excluded.outcome END`).run(provider, event, at, HUNCH_VERSION, evidence);
    });
  } catch { /* evidence is optional; the hook response is not */ }
}

export function readHookObservations(root: string): HookObservation[] {
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return [];
  return withServedDatabase(root, db => {
    ensureTable(db);
    return db.prepare("SELECT provider, event, at, version, outcome FROM hook_observations ORDER BY at DESC").all() as unknown as HookObservation[];
  });
}
