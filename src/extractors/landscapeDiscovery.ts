import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { resourceId, resourceRelationshipId } from "../core/ids.js";
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
const ORDINARY_BLOB_MODES = new Set(["100644", "100755"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type LandscapeEvidenceKind = "package_manifest" | "git_remote" | "git_history";

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
  | "repository_identity_conflict";

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
