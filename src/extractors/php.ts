import { posix } from "node:path";
import { compareCodeUnits } from "../core/canonicalOrder.js";

export interface PhpPsr4Mapping {
  prefix: string;
  directories: string[];
}

export interface PhpUseImport {
  fqn: string;
  alias: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeComposerDirectory(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

/** Extract bounded, repository-relative PSR-4 mappings from composer.json.
 * autoload-dev is included because test symbols and changed-file history are
 * first-class graph inputs. Unsafe/absolute mapping roots are ignored. */
export function composerPsr4Mappings(value: unknown): PhpPsr4Mapping[] {
  const root = object(value);
  if (!root) return [];
  const merged = new Map<string, Set<string>>();
  for (const sectionName of ["autoload", "autoload-dev"]) {
    const psr4 = object(object(root[sectionName])?.["psr-4"]);
    if (!psr4) continue;
    for (const [prefix, raw] of Object.entries(psr4)) {
      if (!prefix || prefix.length > 512 || !prefix.endsWith("\\")) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const entry of values) {
        if (typeof entry !== "string") continue;
        const directory = safeComposerDirectory(entry);
        if (directory) (merged.get(prefix) ?? merged.set(prefix, new Set()).get(prefix)!).add(directory);
      }
    }
  }
  return [...merged]
    .map(([prefix, directories]) => ({ prefix, directories: [...directories].sort(compareCodeUnits) }))
    .sort((a, b) => b.prefix.length - a.prefix.length || compareCodeUnits(a.prefix, b.prefix));
}

function splitAliases(value: string): { name: string; alias: string | null } {
  const match = /^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(value.trim());
  return match ? { name: match[1]!.trim(), alias: match[2]! } : { name: value.trim(), alias: null };
}

/** Parse ordinary, aliased, comma-separated, function/const, and grouped PHP
 * namespace-use declarations. Dynamic namespace expressions do not exist in
 * this syntax, so every returned import is exact. */
export function parsePhpUseDeclaration(raw: string): PhpUseImport[] {
  if (!/^\s*use\b/i.test(raw)) return [];
  let body = raw.trim().replace(/^use\s+/i, "").replace(/;\s*$/, "").trim();
  body = body.replace(/^(?:function|const)\s+/i, "").trim();
  const out: PhpUseImport[] = [];
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  const add = (value: string, prefix = "") => {
    const typed = value.trim().replace(/^(?:function|const)\s+/i, "");
    const { name, alias } = splitAliases(typed);
    const fqn = `${prefix}${name}`.replace(/^\\+/, "").replace(/\\+/g, "\\");
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/.test(fqn)) return;
    out.push({ fqn, alias: alias ?? fqn.split("\\").pop()! });
  };
  if (open >= 0 && close > open) {
    const prefix = body.slice(0, open).trim().replace(/\\?$/, "\\");
    for (const item of body.slice(open + 1, close).split(",")) add(item, prefix);
  } else {
    for (const item of body.split(",")) add(item);
  }
  return out;
}

function mapFqnToFiles(fqn: string, mappings: readonly PhpPsr4Mapping[], files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const mapping of mappings) {
    if (!fqn.startsWith(mapping.prefix)) continue;
    const suffix = fqn.slice(mapping.prefix.length).replaceAll("\\", "/");
    if (!suffix) continue;
    for (const directory of mapping.directories) {
      const candidate = `${directory}/${suffix}.php`;
      if (files.has(candidate)) out.push(candidate);
    }
    if (out.length) break; // longest PSR-4 prefix wins
  }
  return [...new Set(out)].sort();
}

function useAliasMap(useDeclarations: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const declaration of useDeclarations) {
    for (const entry of parsePhpUseDeclaration(declaration)) aliases.set(entry.alias.toLowerCase(), entry.fqn);
  }
  return aliases;
}

function expandedFqn(reference: string, namespace: string | null, useDeclarations: readonly string[]): string | null {
  const raw = reference.trim();
  if (!raw || /^(?:self|static|parent)$/i.test(raw) || raw.startsWith("$")) return null;
  if (raw.startsWith("\\")) return raw.replace(/^\\+/, "");
  if (/^namespace\\/i.test(raw)) return namespace ? `${namespace}\\${raw.slice("namespace\\".length)}` : raw.slice("namespace\\".length);
  const parts = raw.split("\\");
  const imported = useAliasMap(useDeclarations).get(parts[0]!.toLowerCase());
  if (imported) return [imported, ...parts.slice(1)].join("\\");
  return namespace ? `${namespace}\\${raw}` : raw;
}

export interface PhpResolvedReference {
  symbolName: string;
  files: string[];
}

export function resolvePhpReference(
  reference: string,
  namespace: string | null,
  useDeclarations: readonly string[],
  mappings: readonly PhpPsr4Mapping[],
  files: ReadonlySet<string>,
): PhpResolvedReference {
  const fqn = expandedFqn(reference, namespace, useDeclarations);
  const fallback = reference.replace(/^\\+/, "").split("\\").pop() ?? reference;
  if (!fqn) return { symbolName: fallback, files: [] };
  return { symbolName: fqn.split("\\").pop()!, files: mapFqnToFiles(fqn, mappings, files) };
}

function includeTarget(fromFile: string, expression: string, files: ReadonlySet<string>): string[] {
  if (!/^\s*(?:include|include_once|require|require_once)\b/i.test(expression)) return [];
  // tree-sitter-php's include/require node range ends before the closing quote
  // for a plain string child, so accept end-of-capture as the exact terminator.
  const literals = [...expression.matchAll(/['"]([^'"]+)(?:['"]|$)/g)].map((match) => match[1]!).filter(Boolean);
  if (literals.length !== 1) return []; // concatenated dynamic fragments are not exact
  let literal = literals[0]!.replaceAll("\\", "/");
  if (literal.includes("\0")) return [];
  let base = posix.dirname(fromFile);
  const anchoredToDir = /__DIR__/i.test(expression);
  if (/dirname\s*\(\s*__DIR__\s*\)/i.test(expression)) base = posix.dirname(base);
  else if (!anchoredToDir && !/^\s*(?:include|include_once|require|require_once)\s*['"]/i.test(expression)) return [];
  if (literal.startsWith("/")) {
    if (!anchoredToDir) return [];
    literal = literal.replace(/^\/+/, "");
  }
  const candidate = posix.normalize(posix.join(base, literal)).replace(/^\.\//, "");
  if (!candidate || candidate === ".." || candidate.startsWith("../")) return [];
  return files.has(candidate) ? [candidate] : [];
}

/** Resolve one parser import capture. A namespace-use declaration can map to
 * multiple local files; object/static class references map through aliases and
 * current namespace; static include/require paths stay fail-closed. */
export function resolvePhpImportTargets(
  fromFile: string,
  capture: string,
  namespace: string | null,
  useDeclarations: readonly string[],
  mappings: readonly PhpPsr4Mapping[],
  files: ReadonlySet<string>,
): string[] {
  if (/^\s*use\b/i.test(capture)) {
    return [...new Set(parsePhpUseDeclaration(capture).flatMap((entry) => mapFqnToFiles(entry.fqn, mappings, files)))].sort();
  }
  if (/^\s*(?:include|include_once|require|require_once)\b/i.test(capture)) {
    return includeTarget(fromFile, capture, files);
  }
  return resolvePhpReference(capture, namespace, useDeclarations, mappings, files).files;
}

export function phpExternalSpecifier(capture: string): string | null {
  const imported = parsePhpUseDeclaration(capture)[0]?.fqn ?? capture.replace(/^\\+/, "").trim();
  if (!imported || /^\s*(?:include|include_once|require|require_once)\b/i.test(imported)) return null;
  const vendor = imported.split("\\")[0];
  return vendor && /^[A-Za-z_][A-Za-z0-9_]*$/.test(vendor) ? `php:${vendor.toLowerCase()}` : null;
}
