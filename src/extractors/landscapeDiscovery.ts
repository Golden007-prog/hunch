import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { resourceId, resourceRelationshipId } from "../core/ids.js";
import { parseJsonc } from "../core/jsonc.js";
import { parseSource } from "./parse.js";
import {
  EdgeSchema,
  ResourceSchema,
  isCredentialFreeText,
  type Edge,
  type Resource,
  type ResourceCurrentness,
} from "../core/types.js";
import {
  canonicalRemoteRepositoryIdentity,
  foreignRepoEnv,
  gitNullDevice,
  isGitRepo,
} from "./git.js";

export const LANDSCAPE_DISCOVERY_SCHEMA_VERSION = "hunch.landscape-discovery/1" as const;
export const LANDSCAPE_CANDIDATE_SCHEMA_VERSION = "hunch.landscape-candidate/1" as const;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFESTS = 128;
const MAX_MCP_CONFIG_BYTES = 256 * 1024;
const MAX_MCP_DECLARATIONS = 128;
const MAX_DELIVERY_DECLARATION_BYTES = 256 * 1024;
const MAX_DELIVERY_DECLARATIONS = 128;
const ORDINARY_BLOB_MODES = new Set(["100644", "100755"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
type McpConfigSpec =
  | { path: string; format: "jsonc"; rootKey: "mcpServers" | "servers" }
  | { path: string; format: "codex_toml" }
  | { path: string; format: "registry_json" };

const MCP_CONFIG_SPECS: readonly McpConfigSpec[] = [
  { path: ".mcp.json", format: "jsonc", rootKey: "mcpServers" },
  { path: ".agents/mcp_config.json", format: "jsonc", rootKey: "mcpServers" },
  { path: ".codex/config.toml", format: "codex_toml" },
  { path: ".cursor/mcp.json", format: "jsonc", rootKey: "mcpServers" },
  { path: ".vscode/mcp.json", format: "jsonc", rootKey: "servers" },
  { path: ".windsurf/mcp_config.json", format: "jsonc", rootKey: "mcpServers" },
  { path: "plugin/.mcp.json", format: "jsonc", rootKey: "mcpServers" },
  { path: "server.json", format: "registry_json" },
];
const MCP_CONFIG_BY_PATH = new Map<string, McpConfigSpec>(MCP_CONFIG_SPECS.map((spec) => [spec.path, spec]));

export type LandscapeEvidenceKind =
  | "package_manifest"
  | "git_remote"
  | "git_history"
  | "mcp_declaration"
  | "ci_declaration"
  | "deployment_declaration";

export interface LandscapeCandidateEvidence {
  kind: LandscapeEvidenceKind;
  sourcePath: string;
  sourceField: string;
  sourceRevision: string;
  sourceContentHash: string;
}

export interface LandscapeCandidate<T extends Resource | Edge> {
  schema: typeof LANDSCAPE_CANDIDATE_SCHEMA_VERSION;
  authority: "candidate";
  record: T;
  evidence: LandscapeCandidateEvidence[];
  candidateHash: string;
}

export type LandscapeDiscoveryIssueCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_oversized"
  | "manifest_mode"
  | "manifest_path"
  | "manifest_limit"
  | "workspace_pattern_invalid"
  | "package_name_missing"
  | "package_name_invalid"
  | "repository_identity_conflict"
  | "mcp_config_invalid"
  | "mcp_config_oversized"
  | "mcp_config_mode"
  | "mcp_server_name_invalid"
  | "mcp_declaration_invalid"
  | "mcp_declaration_conflict"
  | "mcp_declaration_limit"
  | "delivery_declaration_invalid"
  | "delivery_declaration_oversized"
  | "delivery_declaration_mode"
  | "delivery_declaration_path"
  | "delivery_declaration_limit";

export interface LandscapeDiscoveryIssue {
  code: LandscapeDiscoveryIssueCode;
  sourcePath: string;
  sourceField: string;
  detail: string;
}

export interface LandscapeDiscoveryResult {
  schema: typeof LANDSCAPE_DISCOVERY_SCHEMA_VERSION;
  authority: "candidate";
  sourceRevision: string;
  repositoryRootIdentity: string;
  resources: Array<LandscapeCandidate<Resource>>;
  relationships: Array<LandscapeCandidate<Edge>>;
  issues: LandscapeDiscoveryIssue[];
  discoveryHash: string;
}

interface ManifestBlob {
  path: string;
  mode: string;
  oid: string;
  bytes: Buffer | null;
  contentHash: string | null;
}

interface ParsedManifest {
  path: string;
  value: Record<string, unknown>;
  contentHash: string;
}

interface RepositoryDeclaration {
  identity: string;
  key: string;
  locator: string | null;
  evidence: LandscapeCandidateEvidence;
}

interface McpDeclaration {
  key: string;
  name: string;
  transport: "stdio" | "http";
  relationship: "depends_on" | "provides";
  locator: string | null;
  descriptorHash: string;
  evidence: LandscapeCandidateEvidence;
}

interface DeliveryDeclarationSpec {
  evidenceKind: "ci_declaration" | "deployment_declaration";
  resourceKind: "pipeline" | "artifact" | "deployment_target";
  provider: "github_actions" | "gitlab_ci" | "circleci" | "buildkite" | "jenkins" | "docker" | "docker_compose";
  format: "yaml" | "dockerfile" | "jenkinsfile";
  sourceField: string;
  relationship: "contains" | "builds" | "deploys";
}

interface DeliveryDeclarationBlob extends ManifestBlob {
  spec: DeliveryDeclarationSpec | null;
}

interface DeliveryDeclaration {
  path: string;
  contentHash: string;
  spec: DeliveryDeclarationSpec;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...foreignRepoEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullDevice(),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function gitBuffer(root: string, args: string[], maxBuffer = 8 * 1024 * 1024): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: gitEnv(),
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
}

function gitText(root: string, args: string[], maxBuffer = 8 * 1024 * 1024): string {
  return gitBuffer(root, args, maxBuffer).toString("utf8").trim();
}

function sha256Bytes(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => [key, canonical(child)]));
}

function contentHash(value: unknown): string {
  return sha256Bytes(JSON.stringify(canonical(value)));
}

function exactRevision(root: string, ref: string): string {
  const revision = gitText(root, ["rev-parse", "--verify", `${ref}^{commit}`]).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("landscape discovery requires an exact Git commit");
  return revision;
}

function revisionTime(root: string, revision: string): string {
  const value = gitText(root, ["show", "-s", "--format=%cI", revision], 1024 * 1024);
  if (!Number.isFinite(Date.parse(value))) throw new Error("landscape discovery commit timestamp is invalid");
  return value;
}

function nulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    if (end > start) records.push(bytes.subarray(start, end));
    start = end + 1;
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

function manifestBlobs(root: string, revision: string): ManifestBlob[] {
  const raw = gitBuffer(root, ["ls-tree", "--full-tree", "-r", "-z", revision], 64 * 1024 * 1024);
  const manifests: ManifestBlob[] = [];
  for (const record of nulRecords(raw)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const head = record.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i);
    if (!head) continue;
    const pathBytes = record.subarray(tab + 1);
    let path: string;
    try {
      path = UTF8_DECODER.decode(pathBytes);
    } catch {
      const suffix = Buffer.from("package.json", "utf8");
      if (pathBytes.length >= suffix.length && pathBytes.subarray(pathBytes.length - suffix.length).equals(suffix)) {
        manifests.push({
          path: `<non-utf8-package-manifest:sha256:${createHash("sha256").update(pathBytes).digest("hex")}>`,
          mode: "unsafe-path",
          oid: head[3]!.toLowerCase(),
          bytes: null,
          contentHash: null,
        });
      }
      continue;
    }
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    const mode = head[1]!;
    const oid = head[3]!.toLowerCase();
    const segments = path.split("/");
    if (path.length > 1024 || path.startsWith("/") || path.includes("\\")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || /[\u0000-\u001f\u007f]/.test(path) || !isCredentialFreeText(path)) {
      manifests.push({ path: "<unsafe-package-manifest>", mode: "unsafe-path", oid, bytes: null, contentHash: null });
      continue;
    }
    manifests.push({ path, mode: head[2] === "blob" ? mode : `${head[2]}:${mode}`, oid, bytes: null, contentHash: null });
  }
  return manifests.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function boundedManifestBlobs(root: string, manifests: ManifestBlob[]): ManifestBlob[] {
  const rootManifest = manifests.find((manifest) => manifest.path === "package.json");
  const selected = [
    ...(rootManifest ? [rootManifest] : []),
    ...manifests.filter((manifest) => manifest !== rootManifest).slice(0, MAX_MANIFESTS - (rootManifest ? 1 : 0)),
  ];
  return selected.map((manifest) => {
    if (manifest.mode === "unsafe-path" || !ORDINARY_BLOB_MODES.has(manifest.mode)) return manifest;
    const size = Number(gitText(root, ["cat-file", "-s", manifest.oid], 1024 * 1024));
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MANIFEST_BYTES) {
      return { ...manifest, contentHash: size > MAX_MANIFEST_BYTES ? "oversized" : null };
    }
    const bytes = gitBuffer(root, ["cat-file", "blob", manifest.oid], MAX_MANIFEST_BYTES + 1);
    return { ...manifest, bytes, contentHash: sha256Bytes(bytes) };
  });
}

function workspacePatterns(value: unknown, issues: LandscapeDiscoveryIssue[]): string[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : [];
  const patterns: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string") {
      issues.push({
        code: "workspace_pattern_invalid",
        sourcePath: "package.json",
        sourceField: "workspaces",
        detail: "workspace entries must be repository-relative string patterns",
      });
      continue;
    }
    const pattern = entry.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const segments = pattern.split("/");
    if (!pattern || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)
      || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      issues.push({
        code: "workspace_pattern_invalid",
        sourcePath: "package.json",
        sourceField: "workspaces",
        detail: `workspace pattern at index ${index} is not a safe repository-relative pattern`,
      });
      continue;
    }
    patterns.push(pattern);
  }
  return [...new Set(patterns)].sort(compareCodeUnits);
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function isWorkspaceManifest(path: string, patterns: string[]): boolean {
  if (path === "package.json") return true;
  const directory = posix.dirname(path);
  return patterns.some((pattern) => globRegex(pattern).test(directory));
}

function parseManifests(blobs: ManifestBlob[], issues: LandscapeDiscoveryIssue[]): ParsedManifest[] {
  const parsed: ParsedManifest[] = [];
  for (const blob of blobs) {
    if (!blob.bytes) {
      issues.push({
        code: blob.contentHash === "oversized" ? "manifest_oversized" : blob.mode === "unsafe-path" ? "manifest_path" : "manifest_mode",
        sourcePath: blob.path,
        sourceField: "",
        detail: blob.contentHash === "oversized"
          ? `${blob.path} exceeds the ${MAX_MANIFEST_BYTES}-byte manifest limit`
          : blob.mode === "unsafe-path" ? "a package manifest uses an unsafe path" : `${blob.path} uses unsupported Git mode ${blob.mode}`,
      });
      continue;
    }
    try {
      const value = JSON.parse(blob.bytes.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest root is not an object");
      parsed.push({ path: blob.path, value: value as Record<string, unknown>, contentHash: blob.contentHash! });
    } catch {
      issues.push({ code: "manifest_invalid", sourcePath: blob.path, sourceField: "", detail: `${blob.path} is not valid JSON object data` });
    }
  }
  return parsed;
}

function mcpConfigBlobs(root: string, revision: string): ManifestBlob[] {
  const raw = gitBuffer(root, [
    "ls-tree", "--full-tree", "-z", revision, "--", ...MCP_CONFIG_SPECS.map((spec) => spec.path),
  ], 4 * 1024 * 1024);
  const blobs: ManifestBlob[] = [];
  for (const record of nulRecords(raw)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const head = record.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i);
    if (!head) continue;
    let path: string;
    try {
      path = UTF8_DECODER.decode(record.subarray(tab + 1));
    } catch {
      continue;
    }
    if (!MCP_CONFIG_BY_PATH.has(path)) continue;
    const mode = head[2] === "blob" ? head[1]! : `${head[2]}:${head[1]}`;
    blobs.push({ path, mode, oid: head[3]!.toLowerCase(), bytes: null, contentHash: null });
  }
  return blobs.sort((left, right) => compareCodeUnits(left.path, right.path)).map((blob) => {
    if (!ORDINARY_BLOB_MODES.has(blob.mode)) return blob;
    const size = Number(gitText(root, ["cat-file", "-s", blob.oid], 1024 * 1024));
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MCP_CONFIG_BYTES) {
      return { ...blob, contentHash: size > MAX_MCP_CONFIG_BYTES ? "oversized" : null };
    }
    const bytes = gitBuffer(root, ["cat-file", "blob", blob.oid], MAX_MCP_CONFIG_BYTES + 1);
    return { ...blob, bytes, contentHash: sha256Bytes(bytes) };
  });
}

function validMcpServerName(value: string): string | null {
  const name = value.trim();
  return name.length > 0 && name.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    && isCredentialFreeText(name)
    ? name
    : null;
}

function safeMcpSourceField(rootKey: string, rawName: string): string {
  const name = validMcpServerName(rawName);
  return name ? `${rootKey}.${name}` : `${rootKey}[sha256:${createHash("sha256").update(rawName).digest("hex")}]`;
}

function safeMcpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || !isCredentialFreeText(value)) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
  } catch {
    return null;
  }
}

function stripTomlComment(input: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "#") return input.slice(0, index);
  }
  return input;
}

function tomlStructure(input: string): { depth: number; closedQuote: boolean } {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let depth = 0;
  for (const char of input) {
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    if (depth < 0) throw new Error("unbalanced TOML structure");
  }
  return { depth, closedQuote: quote === null };
}

function tomlStatements(input: string): string[] {
  const statements: string[] = [];
  let pending = "";
  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    pending = pending ? `${pending}\n${line}` : line;
    const state = tomlStructure(pending);
    if (state.depth === 0 && state.closedQuote) {
      statements.push(pending);
      pending = "";
    }
  }
  if (pending) throw new Error("unterminated TOML statement");
  return statements;
}

function parseTomlString(input: string): string {
  const value = input.trim();
  if (value.length < 2) throw new Error("TOML string expected");
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.slice(1, -1).includes("'")) throw new Error("invalid literal TOML string");
    return value.slice(1, -1);
  }
  if (!value.startsWith("\"") || !value.endsWith("\"")) throw new Error("TOML string expected");
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "string") throw new Error("TOML string expected");
  return parsed;
}

function parseTomlKeyPath(input: string): string[] {
  const parts: string[] = [];
  let index = 0;
  const skipSpace = (): void => {
    while (/\s/.test(input[index] ?? "")) index += 1;
  };
  while (index < input.length) {
    skipSpace();
    const char = input[index];
    if (char === "\"" || char === "'") {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < input.length; index += 1) {
        const current = input[index]!;
        if (char === "\"" && escaped) escaped = false;
        else if (char === "\"" && current === "\\") escaped = true;
        else if (current === char) break;
      }
      if (index >= input.length) throw new Error("unterminated quoted TOML key");
      index += 1;
      parts.push(parseTomlString(input.slice(start, index)));
    } else {
      const match = input.slice(index).match(/^[A-Za-z0-9_-]+/);
      if (!match) throw new Error("invalid TOML key");
      parts.push(match[0]);
      index += match[0].length;
    }
    skipSpace();
    if (index === input.length) break;
    if (input[index] !== ".") throw new Error("invalid dotted TOML key");
    index += 1;
  }
  if (!parts.length) throw new Error("empty TOML key");
  return parts;
}

function splitTomlAssignment(input: string): [string, string] {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "=") return [input.slice(0, index).trim(), input.slice(index + 1).trim()];
  }
  throw new Error("TOML assignment expected");
}

function parseTomlStringArray(input: string): string[] {
  const value = input.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("TOML string array expected");
  const body = value.slice(1, -1);
  const items: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "," || index === body.length) {
      const item = body.slice(start, index).trim();
      if (item) items.push(parseTomlString(item));
      start = index + 1;
    }
  }
  if (quote) throw new Error("unterminated TOML array string");
  return items;
}

function parseCodexMcpServers(input: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let current: string | null = null;
  for (const statement of tomlStatements(input)) {
    if (statement.startsWith("[")) {
      if (!statement.endsWith("]") || statement.startsWith("[[") || statement.endsWith("]]")) {
        throw new Error("unsupported TOML table");
      }
      const path = parseTomlKeyPath(statement.slice(1, -1));
      if (path[0] !== "mcp_servers") {
        current = null;
        continue;
      }
      if (path.length !== 2 || Object.hasOwn(servers, path[1]!)) throw new Error("invalid MCP TOML table");
      current = path[1]!;
      servers[current] = {};
      continue;
    }
    if (!current) continue;
    const [rawKey, rawValue] = splitTomlAssignment(statement);
    const keyPath = parseTomlKeyPath(rawKey);
    if (keyPath.length !== 1) throw new Error("invalid MCP TOML key");
    const key = keyPath[0]!;
    if (!new Set(["command", "url", "args"]).has(key)) continue;
    if (Object.hasOwn(servers[current]!, key)) throw new Error("duplicate MCP TOML key");
    servers[current]![key] = key === "args" ? parseTomlStringArray(rawValue) : parseTomlString(rawValue);
  }
  return servers;
}

function validMcpRegistryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(name)
    && isCredentialFreeText(name)
    ? name
    : null;
}

function safeRegistryText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) && isCredentialFreeText(text)
    ? text
    : null;
}

function registryMcpDeclarations(
  parsed: unknown,
  blob: ManifestBlob,
  revision: string,
  issues: LandscapeDiscoveryIssue[],
): McpDeclaration[] {
  const invalid = (): McpDeclaration[] => {
    issues.push({
      code: "mcp_declaration_invalid",
      sourcePath: blob.path,
      sourceField: "name",
      detail: "registry MCP data must declare one bounded package or credential-free HTTP remote transport",
    });
    return [];
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.$schema !== "string"
    || !/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/.test(manifest.$schema)) {
    return [];
  }
  const name = validMcpRegistryName(manifest.name);
  if (!name) {
    issues.push({
      code: "mcp_server_name_invalid",
      sourcePath: blob.path,
      sourceField: "name",
      detail: "the registry manifest uses an invalid or credential-bearing MCP server name",
    });
    return [];
  }
  const evidence: LandscapeCandidateEvidence = {
    kind: "mcp_declaration",
    sourcePath: blob.path,
    sourceField: "name",
    sourceRevision: revision,
    sourceContentHash: blob.contentHash!,
  };
  const packages = manifest.packages === undefined ? [] : manifest.packages;
  const remotes = manifest.remotes === undefined ? [] : manifest.remotes;
  if (!Array.isArray(packages) || !Array.isArray(remotes) || packages.length > 32 || remotes.length > 32) return invalid();
  const packageDescriptors: Array<Record<string, string>> = [];
  for (const value of packages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const item = value as Record<string, unknown>;
    const transport = item.transport;
    if (!transport || typeof transport !== "object" || Array.isArray(transport)
      || (transport as Record<string, unknown>).type !== "stdio") return invalid();
    const registryType = safeRegistryText(item.registryType, 64);
    const identifier = safeRegistryText(item.identifier, 256);
    const version = safeRegistryText(item.version, 128);
    if (!registryType || !identifier || !version) return invalid();
    packageDescriptors.push({ registryType, identifier, version });
  }
  const remoteLocators: string[] = [];
  for (const value of remotes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const item = value as Record<string, unknown>;
    const type = item.type;
    const locator = safeMcpUrl(item.url);
    if ((type !== "sse" && type !== "streamable-http") || !locator) return invalid();
    remoteLocators.push(locator);
  }
  const declarations: McpDeclaration[] = [];
  if (packageDescriptors.length) {
    const descriptors = packageDescriptors.sort((left, right) => compareCodeUnits(
      `${left.registryType}:${left.identifier}:${left.version}`,
      `${right.registryType}:${right.identifier}:${right.version}`,
    ));
    declarations.push({
      key: name.toLowerCase(),
      name,
      transport: "stdio",
      relationship: "provides",
      locator: null,
      descriptorHash: contentHash({ transport: "stdio", packages: descriptors }),
      evidence,
    });
  }
  for (const locator of [...new Set(remoteLocators)].sort(compareCodeUnits)) {
    declarations.push({
      key: name.toLowerCase(),
      name,
      transport: "http",
      relationship: "provides",
      locator,
      descriptorHash: contentHash({ transport: "http", locator }),
      evidence,
    });
  }
  return declarations.length ? declarations : invalid();
}

function mcpDeclaration(
  rawName: string,
  rawEntry: unknown,
  blob: ManifestBlob,
  rootKey: string,
  revision: string,
  issues: LandscapeDiscoveryIssue[],
): McpDeclaration | null {
  const sourceField = safeMcpSourceField(rootKey, rawName);
  const name = validMcpServerName(rawName);
  if (!name) {
    issues.push({
      code: "mcp_server_name_invalid",
      sourcePath: blob.path,
      sourceField,
      detail: "an MCP declaration uses an invalid or credential-bearing server name",
    });
    return null;
  }
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    issues.push({ code: "mcp_declaration_invalid", sourcePath: blob.path, sourceField, detail: `MCP server ${name} must be an object declaration` });
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;
  const rawUrl = entry.url ?? entry.serverUrl;
  const locator = rawUrl === undefined ? null : safeMcpUrl(rawUrl);
  const command = typeof entry.command === "string" ? entry.command.trim() : null;
  const args = entry.args === undefined
    ? []
    : Array.isArray(entry.args) && entry.args.length <= 64 && entry.args.every((arg) => typeof arg === "string" && arg.length <= 1024)
      ? entry.args as string[]
      : null;
  const validCommand = command !== null && command.length > 0 && command.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(command) && isCredentialFreeText(command);
  if ((rawUrl !== undefined && locator === null) || args === null
    || (rawUrl === undefined && !validCommand) || (rawUrl !== undefined && command !== null)) {
    issues.push({
      code: "mcp_declaration_invalid",
      sourcePath: blob.path,
      sourceField,
      detail: `MCP server ${name} must declare one credential-free HTTP URL or one bounded stdio command`,
    });
    return null;
  }
  const transport = locator ? "http" as const : "stdio" as const;
  const descriptorHash = locator
    ? contentHash({ transport, locator })
    : contentHash({ transport, command, args });
  return {
    key: name.toLowerCase(),
    name,
    transport,
    relationship: "depends_on",
    locator,
    descriptorHash,
    evidence: {
      kind: "mcp_declaration",
      sourcePath: blob.path,
      sourceField,
      sourceRevision: revision,
      sourceContentHash: blob.contentHash!,
    },
  };
}

function mcpDeclarations(root: string, revision: string, issues: LandscapeDiscoveryIssue[]): McpDeclaration[] {
  const declarations: McpDeclaration[] = [];
  let considered = 0;
  for (const blob of mcpConfigBlobs(root, revision)) {
    if (!blob.bytes) {
      issues.push({
        code: blob.contentHash === "oversized" ? "mcp_config_oversized" : "mcp_config_mode",
        sourcePath: blob.path,
        sourceField: "",
        detail: blob.contentHash === "oversized"
          ? `${blob.path} exceeds the ${MAX_MCP_CONFIG_BYTES}-byte MCP configuration limit`
          : `${blob.path} uses unsupported Git mode ${blob.mode}`,
      });
      continue;
    }
    const spec = MCP_CONFIG_BY_PATH.get(blob.path)!;
    let parsed: unknown;
    try {
      parsed = spec.format === "codex_toml"
        ? parseCodexMcpServers(blob.bytes.toString("utf8"))
        : spec.format === "registry_json"
          ? JSON.parse(blob.bytes.toString("utf8")) as unknown
          : parseJsonc(blob.bytes.toString("utf8"));
    } catch {
      issues.push({
        code: "mcp_config_invalid",
        sourcePath: blob.path,
        sourceField: "",
        detail: `${blob.path} is not valid ${spec.format === "codex_toml" ? "bounded MCP TOML" : spec.format === "registry_json" ? "JSON" : "JSON/JSONC"}`,
      });
      continue;
    }
    if (spec.format === "registry_json") {
      const registryDeclarations = registryMcpDeclarations(parsed, blob, revision, issues);
      if (!registryDeclarations.length) continue;
      const logicalCount = registryDeclarations.length;
      if (considered + logicalCount > MAX_MCP_DECLARATIONS) {
        issues.push({
          code: "mcp_declaration_limit",
          sourcePath: blob.path,
          sourceField: "name",
          detail: `bounded discovery accepts at most ${MAX_MCP_DECLARATIONS} MCP declarations`,
        });
        continue;
      }
      considered += logicalCount;
      declarations.push(...registryDeclarations);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push({ code: "mcp_config_invalid", sourcePath: blob.path, sourceField: "", detail: `${blob.path} must contain MCP table data` });
      continue;
    }
    const rootKey = spec.format === "codex_toml" ? "mcp_servers" : spec.rootKey;
    const servers = spec.format === "codex_toml" ? parsed : (parsed as Record<string, unknown>)[rootKey];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      if (spec.format !== "codex_toml") {
        issues.push({ code: "mcp_config_invalid", sourcePath: blob.path, sourceField: rootKey, detail: `${blob.path} must contain an object at ${rootKey}` });
      }
      continue;
    }
    const entries = Object.entries(servers).sort(([left], [right]) => compareCodeUnits(left, right));
    if (considered + entries.length > MAX_MCP_DECLARATIONS) {
      issues.push({
        code: "mcp_declaration_limit",
        sourcePath: blob.path,
        sourceField: rootKey,
        detail: `bounded discovery accepts at most ${MAX_MCP_DECLARATIONS} MCP declarations`,
      });
    }
    const remaining = Math.max(0, MAX_MCP_DECLARATIONS - considered);
    const selectedEntries = entries.slice(0, remaining);
    considered += selectedEntries.length;
    for (const [name, entry] of selectedEntries) {
      const declaration = mcpDeclaration(name, entry, blob, rootKey, revision, issues);
      if (declaration) declarations.push(declaration);
    }
  }
  return declarations.sort((left, right) => compareCodeUnits(
    `${left.key}:${left.descriptorHash}:${left.evidence.sourcePath}`,
    `${right.key}:${right.descriptorHash}:${right.evidence.sourcePath}`,
  ));
}

function deliveryDeclarationSpec(path: string): DeliveryDeclarationSpec | null {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
    return {
      evidenceKind: "ci_declaration",
      resourceKind: "pipeline",
      provider: "github_actions",
      format: "yaml",
      sourceField: "jobs",
      relationship: "contains",
    };
  }
  if (path === ".gitlab-ci.yml") {
    return {
      evidenceKind: "ci_declaration",
      resourceKind: "pipeline",
      provider: "gitlab_ci",
      format: "yaml",
      sourceField: "$",
      relationship: "contains",
    };
  }
  if (path === ".circleci/config.yml") {
    return {
      evidenceKind: "ci_declaration",
      resourceKind: "pipeline",
      provider: "circleci",
      format: "yaml",
      sourceField: "jobs",
      relationship: "contains",
    };
  }
  if (/^\.buildkite\/pipeline\.ya?ml$/.test(path)) {
    return {
      evidenceKind: "ci_declaration",
      resourceKind: "pipeline",
      provider: "buildkite",
      format: "yaml",
      sourceField: "steps",
      relationship: "contains",
    };
  }
  if (path === "Jenkinsfile") {
    return {
      evidenceKind: "ci_declaration",
      resourceKind: "pipeline",
      provider: "jenkins",
      format: "jenkinsfile",
      sourceField: "pipeline",
      relationship: "contains",
    };
  }
  if (/(^|\/)Dockerfile(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(path)) {
    return {
      evidenceKind: "deployment_declaration",
      resourceKind: "artifact",
      provider: "docker",
      format: "dockerfile",
      sourceField: "FROM",
      relationship: "builds",
    };
  }
  if (/(^|\/)(?:compose|docker-compose)\.ya?ml$/.test(path)) {
    return {
      evidenceKind: "deployment_declaration",
      resourceKind: "deployment_target",
      provider: "docker_compose",
      format: "yaml",
      sourceField: "services",
      relationship: "deploys",
    };
  }
  return null;
}

function safeDeclarationPath(path: string): boolean {
  const segments = path.split("/");
  return path.length > 0
    && path.length <= 1024
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/^[A-Za-z]:/.test(path)
    && !/[\u0000-\u001f\u007f]/.test(path)
    && !/(^|[._/-])(authorization|bearer|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)\s*[:=]/i.test(path)
    && segments.every((segment) => !!segment && segment !== "." && segment !== "..")
    && isCredentialFreeText(path);
}

function deliveryDeclarationBlobs(root: string, revision: string): { blobs: DeliveryDeclarationBlob[]; total: number } {
  const raw = gitBuffer(root, ["ls-tree", "--full-tree", "-r", "-z", revision], 64 * 1024 * 1024);
  const discovered: DeliveryDeclarationBlob[] = [];
  for (const record of nulRecords(raw)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const head = record.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i);
    if (!head) continue;
    const pathBytes = record.subarray(tab + 1);
    let path: string;
    try {
      path = UTF8_DECODER.decode(pathBytes);
    } catch {
      const approximate = pathBytes.toString("latin1");
      if (deliveryDeclarationSpec(approximate)) {
        discovered.push({
          path: `<unsafe-delivery-declaration:sha256:${createHash("sha256").update(pathBytes).digest("hex")}>`,
          mode: "unsafe-path",
          oid: head[3]!.toLowerCase(),
          bytes: null,
          contentHash: null,
          spec: null,
        });
      }
      continue;
    }
    const spec = deliveryDeclarationSpec(path);
    if (!spec) continue;
    if (!safeDeclarationPath(path)) {
      discovered.push({
        path: `<unsafe-delivery-declaration:sha256:${createHash("sha256").update(pathBytes).digest("hex")}>`,
        mode: "unsafe-path",
        oid: head[3]!.toLowerCase(),
        bytes: null,
        contentHash: null,
        spec: null,
      });
      continue;
    }
    discovered.push({
      path,
      mode: head[2] === "blob" ? head[1]! : `${head[2]}:${head[1]}`,
      oid: head[3]!.toLowerCase(),
      bytes: null,
      contentHash: null,
      spec,
    });
  }
  discovered.sort((left, right) => compareCodeUnits(left.path, right.path));
  const total = discovered.length;
  const blobs = discovered.slice(0, MAX_DELIVERY_DECLARATIONS).map((blob) => {
    if (blob.mode === "unsafe-path" || !ORDINARY_BLOB_MODES.has(blob.mode)) return blob;
    const size = Number(gitText(root, ["cat-file", "-s", blob.oid], 1024 * 1024));
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DELIVERY_DECLARATION_BYTES) {
      return { ...blob, contentHash: size > MAX_DELIVERY_DECLARATION_BYTES ? "oversized" : null };
    }
    const bytes = gitBuffer(root, ["cat-file", "blob", blob.oid], MAX_DELIVERY_DECLARATION_BYTES + 1);
    return { ...blob, bytes, contentHash: sha256Bytes(bytes) };
  });
  return { blobs, total };
}

function validDeliveryDeclaration(path: string, spec: DeliveryDeclarationSpec, source: string): boolean {
  if (spec.format === "dockerfile") {
    return /^\s*FROM(?:\s+--platform=(?:"[^"]*"|'[^']*'|\S+))?\s+\S+/im.test(source);
  }
  if (spec.format === "jenkinsfile") {
    return /^\s*(?:pipeline|node)\s*\{/m.test(source);
  }
  const parsed = parseSource(path, source);
  if (!parsed?.parseable) return false;
  if (spec.provider === "github_actions" || spec.provider === "circleci") return /^jobs\s*:/m.test(source);
  if (spec.provider === "buildkite") return /^steps\s*:/m.test(source);
  if (spec.provider === "docker_compose") return /^services\s*:/m.test(source);
  return source.trim().length > 0;
}

function deliveryDeclarations(root: string, revision: string, issues: LandscapeDiscoveryIssue[]): DeliveryDeclaration[] {
  const discovered = deliveryDeclarationBlobs(root, revision);
  if (discovered.total > MAX_DELIVERY_DECLARATIONS) {
    issues.push({
      code: "delivery_declaration_limit",
      sourcePath: ".",
      sourceField: "delivery",
      detail: `repository exposes ${discovered.total} supported delivery declarations; bounded discovery accepts at most ${MAX_DELIVERY_DECLARATIONS}`,
    });
  }
  const declarations: DeliveryDeclaration[] = [];
  for (const blob of discovered.blobs) {
    if (!blob.bytes || !blob.spec) {
      const code = blob.contentHash === "oversized"
        ? "delivery_declaration_oversized"
        : blob.mode === "unsafe-path"
          ? "delivery_declaration_path"
          : "delivery_declaration_mode";
      issues.push({
        code,
        sourcePath: blob.path,
        sourceField: "",
        detail: blob.contentHash === "oversized"
          ? `${blob.path} exceeds the ${MAX_DELIVERY_DECLARATION_BYTES}-byte delivery declaration limit`
          : blob.mode === "unsafe-path"
            ? "a delivery declaration uses an unsafe path"
            : `${blob.path} uses unsupported Git mode ${blob.mode}`,
      });
      continue;
    }
    let source: string;
    try {
      source = UTF8_DECODER.decode(blob.bytes);
    } catch {
      issues.push({
        code: "delivery_declaration_invalid",
        sourcePath: blob.path,
        sourceField: blob.spec.sourceField,
        detail: `${blob.path} is not valid UTF-8 declaration data`,
      });
      continue;
    }
    if (!validDeliveryDeclaration(blob.path, blob.spec, source)) {
      issues.push({
        code: "delivery_declaration_invalid",
        sourcePath: blob.path,
        sourceField: blob.spec.sourceField,
        detail: `${blob.path} is not a structurally valid ${blob.spec.provider} declaration`,
      });
      continue;
    }
    declarations.push({ path: blob.path, contentHash: blob.contentHash!, spec: blob.spec });
  }
  return declarations;
}

function deliveryResourceKey(declaration: DeliveryDeclaration): string {
  const prefix = declaration.spec.provider === "docker"
    ? "container-image"
    : declaration.spec.provider === "docker_compose"
      ? "docker-compose"
      : declaration.spec.provider.replaceAll("_", "-");
  return `${prefix}/${declaration.path}`;
}

function deliveryResourceName(declaration: DeliveryDeclaration): string {
  const base = posix.basename(declaration.path).replace(/\.ya?ml$/, "");
  const label = declaration.spec.resourceKind === "pipeline"
    ? `${declaration.spec.provider.replaceAll("_", " ")} pipeline: ${base}`
    : declaration.spec.resourceKind === "artifact"
      ? `container image declared by ${base}`
      : `Docker Compose deployment: ${base}`;
  return label.slice(0, 256);
}

function repositoryKey(identity: string): { key: string; locator: string | null } {
  const safe = (key: string, locator: string | null): { key: string; locator: string | null } => {
    if (key.length > 1900 || /[\u0000-\u001f\u007f]/.test(key) || !isCredentialFreeText(key)) {
      return { key: `opaque/sha256/${createHash("sha256").update(identity).digest("hex")}`, locator: null };
    }
    return {
      key,
      locator: locator && locator.length <= 2048 && isCredentialFreeText(locator) ? locator : null,
    };
  };
  if (identity.startsWith("provider:github:")) {
    const path = identity.slice("provider:github:".length);
    return safe(`github.com/${path}`, `https://github.com/${path}`);
  }
  if (identity.startsWith("file:")) {
    return { key: `local/sha256/${createHash("sha256").update(identity).digest("hex")}`, locator: null };
  }
  if (identity.startsWith("net:any://")) {
    return safe(identity.slice("net:any://".length), null);
  }
  return safe(identity, null);
}

function packageRepositoryValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = (value as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

function validPackageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name
    && name.length <= 214
    && !/[\u0000-\u001f\u007f\s]/.test(name)
    && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)
    ? name
    : null;
}

function configuredRemotes(root: string, revision: string): RepositoryDeclaration[] {
  let output = "";
  try {
    output = gitText(root, ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"], 4 * 1024 * 1024);
  } catch {
    return [];
  }
  const declarations: RepositoryDeclaration[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(remote\.(.+)\.url)\s+(.+)$/);
    if (!match) continue;
    const identity = canonicalRemoteRepositoryIdentity(match[3]!, root);
    if (!identity) continue;
    const normalized = repositoryKey(identity);
    const remoteField = match[1]!.length <= 256 && isCredentialFreeText(match[1]!)
      ? match[1]!
      : `remote[sha256:${createHash("sha256").update(match[1]!).digest("hex")}].url`;
    declarations.push({
      identity,
      ...normalized,
      evidence: {
        kind: "git_remote",
        sourcePath: ".git/config",
        sourceField: remoteField,
        sourceRevision: revision,
        sourceContentHash: contentHash({ field: remoteField, identity }),
      },
    });
  }
  return declarations;
}

function repositoryDeclarations(root: string, revision: string, rootManifest: ParsedManifest | undefined): RepositoryDeclaration[] {
  const declarations = configuredRemotes(root, revision);
  const manifestRemote = packageRepositoryValue(rootManifest?.value.repository);
  if (manifestRemote && rootManifest) {
    const identity = canonicalRemoteRepositoryIdentity(manifestRemote, root);
    if (identity) {
      declarations.push({
        identity,
        ...repositoryKey(identity),
        evidence: {
          kind: "package_manifest",
          sourcePath: rootManifest.path,
          sourceField: "repository",
          sourceRevision: revision,
          sourceContentHash: rootManifest.contentHash,
        },
      });
    }
  }
  return declarations.sort((left, right) => compareCodeUnits(
    `${left.identity}:${left.evidence.sourcePath}:${left.evidence.sourceField}`,
    `${right.identity}:${right.evidence.sourcePath}:${right.evidence.sourceField}`,
  ));
}

function provenanceEvidence(evidence: LandscapeCandidateEvidence): string {
  return `${evidence.sourcePath}#${evidence.sourceField}@${evidence.sourceRevision}:${evidence.sourceContentHash}`;
}

function candidate<T extends Resource | Edge>(record: T, evidence: LandscapeCandidateEvidence[]): LandscapeCandidate<T> {
  const orderedEvidence = [...evidence].sort((left, right) => compareCodeUnits(
    `${left.kind}:${left.sourcePath}:${left.sourceField}:${left.sourceContentHash}`,
    `${right.kind}:${right.sourcePath}:${right.sourceField}:${right.sourceContentHash}`,
  ));
  const unsigned = {
    schema: LANDSCAPE_CANDIDATE_SCHEMA_VERSION,
    authority: "candidate" as const,
    record,
    evidence: orderedEvidence,
  };
  return { ...unsigned, candidateHash: contentHash(unsigned) };
}

function resourceCurrentness(revision: string, hashes: string[]): ResourceCurrentness {
  return {
    status: "unverified",
    source_revision: revision,
    source_content_hash: contentHash([...hashes].sort(compareCodeUnits)),
  };
}

function rootHistoryIdentity(root: string, revision: string): RepositoryDeclaration {
  const roots = gitText(root, ["rev-list", "--max-parents=0", revision], 4 * 1024 * 1024)
    .split(/\s+/).filter((value) => /^[0-9a-f]{40,64}$/i.test(value)).sort(compareCodeUnits);
  const identity = `git:${roots.join("+") || revision}`;
  return {
    identity,
    ...repositoryKey(identity),
    evidence: {
      kind: "git_history",
      sourcePath: ".git/objects",
      sourceField: "root_commits",
      sourceRevision: revision,
      sourceContentHash: contentHash(roots),
    },
  };
}

/** Discover an exact, reviewable repository candidate fragment. This function
 * never writes Hunch graph state: candidate authority remains explicit until a
 * normal review/capture path accepts the records. */
export function discoverRepositoryLandscape(root: string, ref = "HEAD"): LandscapeDiscoveryResult {
  if (!isGitRepo(root)) throw new Error("landscape discovery requires a Git repository");
  const revision = exactRevision(root, ref);
  const timestamp = revisionTime(root, revision);
  const issues: LandscapeDiscoveryIssue[] = [];
  const blobs = manifestBlobs(root, revision);
  if (blobs.length > MAX_MANIFESTS) {
    issues.push({
      code: "manifest_limit",
      sourcePath: "package.json",
      sourceField: "workspaces",
      detail: `repository exposes ${blobs.length} package manifests; bounded discovery accepts at most ${MAX_MANIFESTS}`,
    });
  }
  const parsed = parseManifests(boundedManifestBlobs(root, blobs), issues);
  const rootManifest = parsed.find((manifest) => manifest.path === "package.json");
  if (!rootManifest) {
    issues.push({ code: "manifest_missing", sourcePath: "package.json", sourceField: "", detail: "root package.json was not found at the exact revision" });
  }
  const patterns = workspacePatterns(rootManifest?.value.workspaces, issues);
  const manifests = parsed.filter((manifest) => isWorkspaceManifest(manifest.path, patterns));
  const declarations = repositoryDeclarations(root, revision, rootManifest);
  const discoveredMcp = mcpDeclarations(root, revision, issues);
  const discoveredDelivery = deliveryDeclarations(root, revision, issues);
  const identities = [...new Set(declarations.map((declaration) => declaration.identity))].sort(compareCodeUnits);
  let selected: RepositoryDeclaration | null = null;
  if (identities.length > 1) {
    issues.push({
      code: "repository_identity_conflict",
      sourcePath: "package.json",
      sourceField: "repository",
      detail: `repository declarations disagree across ${identities.length} canonical identities; package relationships remain unbound`,
    });
  } else if (identities.length === 1) {
    selected = declarations.find((declaration) => declaration.identity === identities[0])!;
  } else {
    selected = rootHistoryIdentity(root, revision);
  }

  const resources: Array<LandscapeCandidate<Resource>> = [];
  const relationships: Array<LandscapeCandidate<Edge>> = [];
  let repositoryRecord: Resource | null = null;
  if (selected) {
    const repositoryEvidence = declarations.length
      ? declarations.filter((declaration) => declaration.identity === selected!.identity).map((declaration) => declaration.evidence)
      : [selected.evidence];
    const packageName = validPackageName(rootManifest?.value.name);
    repositoryRecord = ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: resourceId("repository", selected.key),
      kind: "repository",
      name: packageName ?? selected.key.slice(0, 256),
      scope: [],
      locator: selected.locator,
      lifecycle: "active",
      provenance: {
        source: "extracted:repository-declaration",
        confidence: 0.75,
        evidence: repositoryEvidence.map(provenanceEvidence),
      },
      currentness: resourceCurrentness(revision, repositoryEvidence.map((item) => item.sourceContentHash)),
      metadata: { discovery_authority: "candidate" },
      created_at: timestamp,
      updated_at: timestamp,
    });
    resources.push(candidate(repositoryRecord, repositoryEvidence));
  }

  const mcpByKey = new Map<string, McpDeclaration[]>();
  for (const declaration of discoveredMcp) {
    const group = mcpByKey.get(declaration.key) ?? [];
    group.push(declaration);
    mcpByKey.set(declaration.key, group);
  }
  for (const key of [...mcpByKey.keys()].sort(compareCodeUnits)) {
    const group = mcpByKey.get(key)!;
    const descriptorHashes = [...new Set(group.map((item) => item.descriptorHash))].sort(compareCodeUnits);
    if (descriptorHashes.length > 1) {
      const first = group[0]!;
      issues.push({
        code: "mcp_declaration_conflict",
        sourcePath: first.evidence.sourcePath,
        sourceField: first.evidence.sourceField,
        detail: `MCP server ${first.name} has conflicting committed declarations; identity remains unresolved`,
      });
      continue;
    }
    const first = group[0]!;
    const evidence = group.map((item) => item.evidence);
    const declarationPaths = [...new Set(evidence.map((item) => item.sourcePath))].sort(compareCodeUnits);
    const mcpRecord = ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: resourceId("mcp_server", `declared/${key}`),
      kind: "mcp_server",
      name: first.name,
      scope: repositoryRecord ? [repositoryRecord.id] : [],
      locator: first.locator,
      lifecycle: "active",
      provenance: {
        source: "extracted:mcp-declaration",
        confidence: 0.8,
        evidence: evidence.map(provenanceEvidence),
      },
      currentness: resourceCurrentness(revision, evidence.map((item) => item.sourceContentHash)),
      metadata: {
        discovery_authority: "candidate",
        transport: first.transport,
        declaration_paths: declarationPaths,
      },
      created_at: timestamp,
      updated_at: timestamp,
    });
    resources.push(candidate(mcpRecord, evidence));
    if (!repositoryRecord) continue;
    for (const relationshipType of ["depends_on", "provides"] as const) {
      const relationshipDeclarations = group.filter((item) => item.relationship === relationshipType);
      if (!relationshipDeclarations.length) continue;
      const relationshipEvidence = relationshipDeclarations.map((item) => item.evidence);
      const relationshipPaths = [...new Set(relationshipEvidence.map((item) => item.sourcePath))].sort(compareCodeUnits);
      const relationship = EdgeSchema.parse({
        schema: "hunch.resource-relationship/1",
        id: resourceRelationshipId(repositoryRecord.id, mcpRecord.id, relationshipType),
        from: repositoryRecord.id,
        to: mcpRecord.id,
        type: relationshipType,
        reason: relationshipType === "provides"
          ? `committed registry configuration declares repository-provided MCP server ${first.name}`
          : `committed project configuration declares MCP server dependency ${first.name}`,
        strength: 0.8,
        provenance: {
          source: "extracted:mcp-declaration",
          confidence: 0.8,
          evidence: relationshipEvidence.map(provenanceEvidence),
        },
        currentness: resourceCurrentness(revision, relationshipEvidence.map((item) => item.sourceContentHash)),
        environment: null,
        metadata: { discovery_authority: "candidate", declaration_paths: relationshipPaths },
      });
      relationships.push(candidate(relationship, relationshipEvidence));
    }
  }

  for (const declaration of discoveredDelivery) {
    const evidence: LandscapeCandidateEvidence = {
      kind: declaration.spec.evidenceKind,
      sourcePath: declaration.path,
      sourceField: declaration.spec.sourceField,
      sourceRevision: revision,
      sourceContentHash: declaration.contentHash,
    };
    const deliveryRecord = ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: resourceId(declaration.spec.resourceKind, deliveryResourceKey(declaration)),
      kind: declaration.spec.resourceKind,
      name: deliveryResourceName(declaration),
      scope: repositoryRecord ? [repositoryRecord.id] : [],
      locator: declaration.path,
      lifecycle: "active",
      provenance: {
        source: `extracted:${declaration.spec.evidenceKind}`,
        confidence: 0.8,
        evidence: [provenanceEvidence(evidence)],
      },
      currentness: resourceCurrentness(revision, [declaration.contentHash]),
      metadata: {
        discovery_authority: "candidate",
        declaration_path: declaration.path,
        declaration_format: declaration.spec.format,
        provider: declaration.spec.provider,
      },
      created_at: timestamp,
      updated_at: timestamp,
    });
    resources.push(candidate(deliveryRecord, [evidence]));
    if (!repositoryRecord) continue;
    const relationship = EdgeSchema.parse({
      schema: "hunch.resource-relationship/1",
      id: resourceRelationshipId(repositoryRecord.id, deliveryRecord.id, declaration.spec.relationship),
      from: repositoryRecord.id,
      to: deliveryRecord.id,
      type: declaration.spec.relationship,
      reason: `${declaration.path} declares ${declaration.spec.provider} ${declaration.spec.resourceKind}`,
      strength: 0.8,
      provenance: {
        source: `extracted:${declaration.spec.evidenceKind}`,
        confidence: 0.8,
        evidence: [provenanceEvidence(evidence)],
      },
      currentness: resourceCurrentness(revision, [declaration.contentHash]),
      environment: null,
      metadata: { discovery_authority: "candidate", declaration_path: declaration.path },
    });
    relationships.push(candidate(relationship, [evidence]));
  }

  for (const manifest of manifests) {
    const rawName = typeof manifest.value.name === "string" ? manifest.value.name.trim() : "";
    if (!rawName) {
      issues.push({ code: "package_name_missing", sourcePath: manifest.path, sourceField: "name", detail: `${manifest.path} has no package name` });
      continue;
    }
    const name = validPackageName(rawName);
    if (!name) {
      issues.push({ code: "package_name_invalid", sourcePath: manifest.path, sourceField: "name", detail: `${manifest.path} has an invalid package name` });
      continue;
    }
    const evidence: LandscapeCandidateEvidence = {
      kind: "package_manifest",
      sourcePath: manifest.path,
      sourceField: "name",
      sourceRevision: revision,
      sourceContentHash: manifest.contentHash,
    };
    const packageRecord = ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: resourceId("package", `npm/${name}`),
      kind: "package",
      name,
      scope: repositoryRecord ? [repositoryRecord.id] : [],
      locator: `${manifest.path}#name`,
      lifecycle: "active",
      contract_version: typeof manifest.value.version === "string"
        && manifest.value.version.length <= 128
        && !/[\u0000-\u001f\u007f\s]/.test(manifest.value.version)
        ? manifest.value.version
        : undefined,
      provenance: { source: "extracted:package-manifest", confidence: 0.9, evidence: [provenanceEvidence(evidence)] },
      currentness: resourceCurrentness(revision, [manifest.contentHash]),
      metadata: { discovery_authority: "candidate", manifest_path: manifest.path, workspace: manifest.path !== "package.json" },
      created_at: timestamp,
      updated_at: timestamp,
    });
    resources.push(candidate(packageRecord, [evidence]));
    if (!repositoryRecord) continue;
    const relationship = EdgeSchema.parse({
      schema: "hunch.resource-relationship/1",
      id: resourceRelationshipId(repositoryRecord.id, packageRecord.id, "contains"),
      from: repositoryRecord.id,
      to: packageRecord.id,
      type: "contains",
      reason: `${manifest.path} declares package ${name}`,
      strength: 1,
      provenance: { source: "extracted:package-workspace", confidence: 0.9, evidence: [provenanceEvidence(evidence)] },
      currentness: resourceCurrentness(revision, [manifest.contentHash]),
      environment: null,
      metadata: { discovery_authority: "candidate", manifest_path: manifest.path },
    });
    relationships.push(candidate(relationship, [evidence]));
  }

  resources.sort((left, right) => compareCodeUnits(left.record.id, right.record.id));
  relationships.sort((left, right) => compareCodeUnits(left.record.id, right.record.id));
  issues.sort((left, right) => compareCodeUnits(
    `${left.code}:${left.sourcePath}:${left.sourceField}:${left.detail}`,
    `${right.code}:${right.sourcePath}:${right.sourceField}:${right.detail}`,
  ));
  const unsigned = {
    schema: LANDSCAPE_DISCOVERY_SCHEMA_VERSION,
    authority: "candidate" as const,
    sourceRevision: revision,
    repositoryRootIdentity: selected?.key ?? `conflict:${contentHash(identities)}`,
    resources,
    relationships,
    issues,
  };
  return { ...unsigned, discoveryHash: contentHash(unsigned) };
}
