import { shortHash } from "./ids.js";

/** Canonical package identity for a static module specifier. Relative, absolute,
 * package-import-map (#), and URL-like specifiers are repository/runtime-local
 * and deliberately outside the external-dependency evaluator. */
export function externalPackage(specifier: string): string | null {
  const value = specifier.trim();
  if (!value || value.startsWith(".") || value.startsWith("/") || value.startsWith("#") || /^[a-z]+:\/\//i.test(value)) return null;
  if (value.startsWith("node:")) return /^node:[A-Za-z0-9_./-]+$/.test(value) ? value : null;
  if (value.startsWith("@")) {
    const [scope, name] = value.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }
  return value.split("/")[0] || null;
}

/** Virtual graph target for an external package. It is intentionally not a
 * Component record: package facts stay a bounded evaluator layer and do not
 * inflate the human-curated component graph. */
export function externalImportNodeId(specifier: string): string | null {
  const dependency = externalPackage(specifier);
  return dependency ? `ext_${shortHash(dependency)}` : null;
}
