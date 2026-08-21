import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepositoryLandscape } from "../src/extractors/landscapeDiscovery.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function repository(t: test.TestContext, input: {
  rootManifest: Record<string, unknown>;
  manifests?: Array<{ path: string; value: unknown; raw?: boolean }>;
  remote?: string;
}): { root: string; revision: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-landscape-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Hunch Test");
  git(root, "config", "user.email", "hunch@example.test");
  writeJson(root, "package.json", input.rootManifest);
  for (const manifest of input.manifests ?? []) {
    if (manifest.raw) {
      const target = join(root, manifest.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, String(manifest.value), "utf8");
    } else {
      writeJson(root, manifest.path, manifest.value);
    }
  }
  git(root, "add", "--", "package.json", ...(input.manifests ?? []).map((manifest) => manifest.path));
  git(root, "commit", "-qm", "fixture");
  if (input.remote) git(root, "remote", "add", "origin", input.remote);
  return { root, revision: git(root, "rev-parse", "HEAD") };
}

test("HLG-2 discovers exact package/workspace and credential-free Git-remote candidates deterministically", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      repository: "git+https://github.com/Acme/Platform.git",
    },
    manifests: [
      { path: "packages/api/package.json", value: { name: "@acme/api", version: "2.0.0" } },
      { path: "packages/web/package.json", value: { name: "@acme/web", version: "3.0.0" } },
      { path: "packages/nested/tool/package.json", value: { name: "@acme/not-a-direct-workspace" } },
    ],
    remote: "https://build-user:topsecret-token@github.com/Acme/Platform.git",
  });

  const first = discoverRepositoryLandscape(root, "HEAD");
  const second = discoverRepositoryLandscape(root, revision);
  assert.deepEqual(second, first, "the exact commit and canonical remote declaration are deterministic");
  assert.equal(first.schema, "hunch.landscape-discovery/1");
  assert.equal(first.authority, "candidate");
  assert.equal(first.sourceRevision, revision);
  assert.deepEqual(first.issues, []);
  assert.deepEqual(first.resources.map((item) => item.record.id), [
    "package:npm/@acme/api",
    "package:npm/@acme/platform",
    "package:npm/@acme/web",
    "repository:github.com/acme/platform",
  ]);
  assert.equal(first.relationships.length, 3);
  assert.ok(first.relationships.every((item) => item.record.type === "contains"));
  assert.ok(first.resources.every((item) => item.authority === "candidate"));
  assert.ok(first.resources.every((item) => item.record.metadata.discovery_authority === "candidate"));
  assert.ok(first.resources.every((item) => item.evidence.every((evidence) => evidence.sourceRevision === revision)));
  assert.match(first.resources.find((item) => item.record.kind === "repository")!.record.locator!, /^https:\/\/github\.com\/acme\/platform$/);
  assert.doesNotMatch(JSON.stringify(first), /topsecret|build-user/i, "credentials and transport usernames never enter candidates");
  assert.equal(existsSync(join(root, ".hunch")), false, "discovery is read-only and does not create graph state");

  const committedManifest = readFileSync(join(root, "package.json"), "utf8");
  writeJson(root, "package.json", { name: "@acme/working-copy", workspaces: [] });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first, "working-tree manifest edits cannot change an exact-revision result");
  writeFileSync(join(root, "package.json"), committedManifest, "utf8");
});

test("HLG-2 preserves conflicting repository declarations as uncertainty instead of choosing authority", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      workspaces: ["packages/*"],
      repository: "https://github.com/acme/platform.git",
    },
    manifests: [{ path: "packages/api/package.json", value: { name: "@acme/api" } }],
    remote: "git@github.com:acme/different-repository.git",
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "repository_identity_conflict"));
  assert.equal(result.resources.some((item) => item.record.kind === "repository"), false);
  assert.equal(result.relationships.length, 0, "packages remain unbound while repository identity is ambiguous");
  assert.ok(result.resources.every((item) => item.record.scope.length === 0));
});

test("HLG-2 bounds malformed manifests and unsafe workspace declarations as reviewable issues", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      workspaces: ["packages/*", "../outside", 42],
    },
    manifests: [
      { path: "packages/missing/package.json", value: { version: "1.0.0" } },
      { path: "packages/broken/package.json", value: "{ definitely not json", raw: true },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "workspace_pattern_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "manifest_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "package_name_missing"));
  assert.equal(result.resources.filter((item) => item.record.kind === "package").length, 1);
  assert.equal(result.relationships.length, 1);
});

test("HLG-2 applies the manifest read cap before blob hydration while always retaining the root declaration", (t) => {
  const manifests = Array.from({ length: 130 }, (_, index) => ({
    path: `a${String(index).padStart(3, "0")}/package.json`,
    value: { name: `@acme/package-${index}` },
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/root", workspaces: ["a*"] },
    manifests,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "manifest_limit"));
  assert.ok(result.resources.some((item) => item.record.id === "package:npm/@acme/root"));
  assert.equal(result.resources.filter((item) => item.record.kind === "package").length, 128);
  assert.equal(result.relationships.length, 128);
});
