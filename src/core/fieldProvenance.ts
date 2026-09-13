import { stateHash } from "./stateCanonical.js";
import type { DerivedState, FieldSelector, DependencyRef } from "./stateRecords.js";

/** Resolve exactly one scalar JSON field or one Unicode-code-point text range.
 * No normalization, inherited properties, array aliases or substring guessing. */
export function fieldCitationValue(content: string, selector: FieldSelector): string | number | boolean | null {
  if (selector.kind === "text") {
    const points = Array.from(content);
    if (!Number.isInteger(selector.start) || !Number.isInteger(selector.end) || selector.start < 0 || selector.end <= selector.start || selector.end > points.length) throw new Error("text citation range must be nonempty and within the content's Unicode code points");
    return points.slice(selector.start, selector.end).join("");
  }
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(selector.path)) throw new Error("citation path must be an escaped JSON Pointer");
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("JSON field citations require JSON content"); }
  for (const encoded of selector.path === "" ? [] : selector.path.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) || !Object.hasOwn(value, key)) throw new Error(`citation path ${selector.path} does not name an existing field`);
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new Error("JSON field citations must name a scalar value, not an object or array");
}

/** This is structural traceability, not a check that a source supports a claim. */
export function assertFieldProvenance(record: Pick<DerivedState, "content" | "dependencies" | "field_provenance">): void {
  if (!record.field_provenance) return;
  const dependencies = new Set(record.dependencies.map(stateHash));
  const selectors = new Set<string>();
  for (const [index, citation] of record.field_provenance.entries()) {
    try {
      const key = stateHash(citation.selector);
      if (selectors.has(key)) throw new Error("duplicate citation selector; combine its dependency hashes in one entry");
      selectors.add(key);
      const value = fieldCitationValue(record.content, citation.selector);
      if (stateHash(value) !== citation.value_hash) throw new Error("citation value_hash does not match the selected content; rebuild the citation after editing");
      if (new Set(citation.dependency_hashes).size !== citation.dependency_hashes.length) throw new Error("duplicate citation dependency hash");
      if (!citation.dependency_hashes.length || citation.dependency_hashes.some(hash => !dependencies.has(hash))) throw new Error("every citation dependency_hash must name an existing summary dependency");
    } catch (error) { throw new Error(`field_provenance[${index}]: ${(error as Error).message}`); }
  }
}

/** Bounded, plain-text source map for assistant clients; structured records remain complete. */
export function fieldCitationText(record: DerivedState): string {
  if (!record.field_provenance?.length) return "";
  const dependencies = new Map(record.dependencies.map(dep => [stateHash(dep), dep]));
  const source = (dep: DependencyRef | undefined): string => !dep ? "unavailable source" : dep.kind === "external"
    ? `${dep.ref.system} ${dep.ref.object_type}:${dep.ref.object_key}` : dep.kind === "record"
    ? `record ${dep.id}${dep.scope ? ` in ${dep.scope.kind}/${dep.scope.id}` : ""}` : `schema ${dep.name}`;
  const lines = record.field_provenance.slice(0, 8).map(citation => {
    const selector = citation.selector;
    const target = selector.kind === "text" ? `text ${selector.start}–${selector.end} (Unicode code points)` : `field ${selector.path || "(root)"}`;
    const value = JSON.stringify(fieldCitationValue(record.content, selector));
    const sources = citation.dependency_hashes.slice(0, 4).map(hash => source(dependencies.get(hash)).slice(0, 200)).join("; ");
    return `    ${target}: ${value.slice(0, 200)}${value.length > 200 ? "…" : ""} ← ${sources}${citation.dependency_hashes.length > 4 ? "; more sources in structured record" : ""}`;
  });
  return `\n    Writer-supplied field citations (traceability, not verified support or freshness):\n${lines.join("\n")}${record.field_provenance.length > 8 ? "\n    More citations in structured record." : ""}`;
}
