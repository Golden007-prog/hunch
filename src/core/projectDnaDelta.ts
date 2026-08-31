import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";
import { assertProjectDnaProfile, type ProjectDnaProfile, type ProjectDnaTrait } from "./projectDna.js";

export const PROJECT_DNA_DELTA_SCHEMA_VERSION = "hunch.project-dna-delta/1" as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DELTA_ID = /^pdnad_[a-f0-9]{24}$/;

export type ProjectDnaChangeKind = "added" | "removed" | "evidence_changed" | "confidence_changed";

export interface ProjectDnaTraitChange {
  key: string;
  kind: ProjectDnaChangeKind;
  before_trait_id: string | null;
  after_trait_id: string | null;
  before_confidence: number | null;
  after_confidence: number | null;
}

export interface ProjectDnaDelta {
  schema: typeof PROJECT_DNA_DELTA_SCHEMA_VERSION;
  delta_id: string;
  from_profile_id: string;
  to_profile_id: string;
  from_revision: string;
  to_revision: string;
  changes: ProjectDnaTraitChange[];
  changed: boolean;
  content_hash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function evidenceSeal(trait: ProjectDnaTrait): string {
  return sha256(canonical(trait.evidence));
}

function mapTraits(profile: ProjectDnaProfile): Map<string, ProjectDnaTrait> {
  return new Map(profile.traits.map((trait) => [trait.key, trait]));
}

/**
 * Compare two already-sealed profiles without inferring causality.
 *
 * A delta says only that observed DNA changed between exact revisions. It does
 * not promote the new trait, explain why the change happened, or grant policy.
 */
export function diffProjectDna(fromValue: unknown, toValue: unknown): ProjectDnaDelta {
  assertProjectDnaProfile(fromValue);
  assertProjectDnaProfile(toValue);
  const from = fromValue;
  const to = toValue;
  const before = mapTraits(from);
  const after = mapTraits(to);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort(compareCodeUnits);
  const changes: ProjectDnaTraitChange[] = [];

  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    if (!left && right) {
      changes.push({
        key,
        kind: "added",
        before_trait_id: null,
        after_trait_id: right.id,
        before_confidence: null,
        after_confidence: right.confidence,
      });
      continue;
    }
    if (left && !right) {
      changes.push({
        key,
        kind: "removed",
        before_trait_id: left.id,
        after_trait_id: null,
        before_confidence: left.confidence,
        after_confidence: null,
      });
      continue;
    }
    if (!left || !right) continue;
    if (left.id !== right.id || evidenceSeal(left) !== evidenceSeal(right)) {
      changes.push({
        key,
        kind: "evidence_changed",
        before_trait_id: left.id,
        after_trait_id: right.id,
        before_confidence: left.confidence,
        after_confidence: right.confidence,
      });
      continue;
    }
    if (left.confidence !== right.confidence) {
      changes.push({
        key,
        kind: "confidence_changed",
        before_trait_id: left.id,
        after_trait_id: right.id,
        before_confidence: left.confidence,
        after_confidence: right.confidence,
      });
    }
  }

  const unsigned = {
    schema: PROJECT_DNA_DELTA_SCHEMA_VERSION,
    from_profile_id: from.profile_id,
    to_profile_id: to.profile_id,
    from_revision: from.repository_revision,
    to_revision: to.repository_revision,
    changes,
    changed: changes.length > 0,
  } as const;
  const deltaId = `pdnad_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, delta_id: deltaId };
  const delta: ProjectDnaDelta = { ...sealed, content_hash: sha256(canonical(sealed)) };
  assertProjectDnaDelta(delta);
  return delta;
}

export function assertProjectDnaDelta(value: unknown): asserts value is ProjectDnaDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project DNA delta is invalid");
  const delta = value as ProjectDnaDelta;
  const expectedFields = [
    "schema", "delta_id", "from_profile_id", "to_profile_id", "from_revision", "to_revision", "changes", "changed", "content_hash",
  ].sort(compareCodeUnits);
  if (Object.keys(value as Record<string, unknown>).sort(compareCodeUnits).join("\0") !== expectedFields.join("\0")
    || delta.schema !== PROJECT_DNA_DELTA_SCHEMA_VERSION || !DELTA_ID.test(delta.delta_id)
    || !/^pdna_[a-f0-9]{24}$/.test(delta.from_profile_id) || !/^pdna_[a-f0-9]{24}$/.test(delta.to_profile_id)
    || !/^[a-f0-9]{40,64}$/.test(delta.from_revision) || !/^[a-f0-9]{40,64}$/.test(delta.to_revision)
    || !Array.isArray(delta.changes) || delta.changes.length > 128 || delta.changed !== (delta.changes.length > 0)
    || !SHA256.test(delta.content_hash)) {
    throw new Error("project DNA delta fields are invalid");
  }
  const seen = new Set<string>();
  for (const change of delta.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("project DNA trait change is invalid");
    const fields = ["key", "kind", "before_trait_id", "after_trait_id", "before_confidence", "after_confidence"].sort(compareCodeUnits);
    if (Object.keys(change as unknown as Record<string, unknown>).sort(compareCodeUnits).join("\0") !== fields.join("\0")
      || !/^[a-z][a-z0-9_.-]{2,100}$/.test(change.key) || seen.has(change.key)
      || !(["added", "removed", "evidence_changed", "confidence_changed"] as const).includes(change.kind)
      || (change.before_trait_id !== null && !/^pdnat_[a-f0-9]{20}$/.test(change.before_trait_id))
      || (change.after_trait_id !== null && !/^pdnat_[a-f0-9]{20}$/.test(change.after_trait_id))
      || (change.before_confidence !== null && (!Number.isFinite(change.before_confidence) || change.before_confidence < 0 || change.before_confidence > 1))
      || (change.after_confidence !== null && (!Number.isFinite(change.after_confidence) || change.after_confidence < 0 || change.after_confidence > 1))) {
      throw new Error("project DNA trait change fields are invalid");
    }
    seen.add(change.key);
  }
  const { content_hash: _contentHash, delta_id: _deltaId, ...base } = delta;
  const expectedId = `pdnad_${sha256(canonical(base)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...base, delta_id: delta.delta_id };
  if (delta.delta_id !== expectedId || delta.content_hash !== sha256(canonical(sealed))) {
    throw new Error("project DNA delta seal is invalid");
  }
}
