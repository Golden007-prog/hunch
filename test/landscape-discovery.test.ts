import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  files?: Array<{ path: string; value: unknown; raw?: boolean }>;
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
  for (const file of input.files ?? []) {
    if (file.raw) {
      const target = join(root, file.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, String(file.value), "utf8");
    } else {
      writeJson(root, file.path, file.value);
    }
  }
  git(root, "add", "--", "package.json",
    ...(input.manifests ?? []).map((manifest) => manifest.path),
    ...(input.files ?? []).map((file) => file.path));
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

test("HLG-2 discovers exact MCP declarations without exposing commands, arguments, environment, or credentials", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".mcp.json",
        value: { mcpServers: { billing: { url: "https://mcp.acme.test/api" } } },
      },
      {
        path: ".vscode/mcp.json",
        raw: true,
        value: `{
          // The same durable declaration through another supported client.
          "servers": { "billing": { "type": "http", "url": "https://mcp.acme.test/api" }, },
        }`,
      },
      {
        path: ".agents/mcp_config.json",
        value: {
          mcpServers: {
            worker: {
              command: "node",
              args: ["private-server.mjs"],
              env: { MCP_ACCESS_TOKEN: "supersecret-fixture-value" },
            },
          },
        },
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const mcp = first.resources.filter((item) => item.record.kind === "mcp_server");
  assert.deepEqual(mcp.map((item) => item.record.id), [
    "mcp_server:declared/billing",
    "mcp_server:declared/worker",
  ]);
  assert.equal(mcp.find((item) => item.record.id.endsWith("/billing"))!.record.locator, "https://mcp.acme.test/api");
  assert.deepEqual(mcp.find((item) => item.record.id.endsWith("/billing"))!.record.metadata.declaration_paths,
    [".mcp.json", ".vscode/mcp.json"]);
  assert.equal(first.relationships.filter((item) => item.record.type === "depends_on").length, 2);
  assert.ok(mcp.every((item) => item.authority === "candidate"));
  assert.ok(mcp.every((item) => item.evidence.every((evidence) => evidence.kind === "mcp_declaration")));
  assert.doesNotMatch(JSON.stringify(first), /private-server|MCP_ACCESS_TOKEN|supersecret-fixture-value/i);

  writeJson(root, ".mcp.json", { mcpServers: { replacement: { command: "changed-working-copy" } } });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree MCP changes cannot alter exact-revision discovery");
});

test("HLG-2 discovers canonical Codex TOML and MCP registry declarations with correct edge direction", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".codex/config.toml",
        raw: true,
        value: `model = "gpt-5"

[mcp_servers.worker]
command = "node"
args = [
  "private-worker.mjs",
  "--token=supersecret-codex-argument",
]
env = { MCP_TOKEN = "supersecret-codex-environment" }

[mcp_servers."billing-http"]
url = "https://billing.acme.test/mcp"
`,
      },
      {
        path: "server.json",
        value: {
          $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: "io.github.acme/platform-mcp",
          version: "1.2.3",
          packages: [{
            registryType: "npm",
            identifier: "@acme/platform-mcp",
            version: "1.2.3",
            transport: { type: "stdio" },
            packageArguments: [{ type: "positional", value: "supersecret-registry-argument" }],
          }],
        },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.deepEqual(result.resources.filter((item) => item.record.kind === "mcp_server").map((item) => item.record.id), [
    "mcp_server:declared/billing-http",
    "mcp_server:declared/io.github.acme/platform-mcp",
    "mcp_server:declared/worker",
  ]);
  assert.equal(result.resources.find((item) => item.record.id.endsWith("/billing-http"))!.record.locator,
    "https://billing.acme.test/mcp");
  assert.equal(result.resources.find((item) => item.record.id.includes("io.github.acme"))!.record.locator, null);
  assert.deepEqual(result.relationships.filter((item) => item.record.type === "depends_on")
    .map((item) => item.record.to).sort(), [
    "mcp_server:declared/billing-http",
    "mcp_server:declared/worker",
  ]);
  assert.deepEqual(result.relationships.filter((item) => item.record.type === "provides").map((item) => item.record.to), [
    "mcp_server:declared/io.github.acme/platform-mcp",
  ]);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /private-worker|supersecret|MCP_TOKEN|packageArguments/i);
});

test("HLG-2 ignores an unrelated server.json and sanitizes invalid Codex TOML names", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "server.json", value: { name: "ordinary-application-server", port: 8080 } },
      {
        path: ".codex/config.toml",
        raw: true,
        value: `[mcp_servers."token=supersecret-codex-name"]
command = "node"
`,
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_server_name_invalid"));
  assert.equal(result.resources.some((item) => item.record.kind === "mcp_server"), false);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|ordinary-application-server/i);
});

test("HLG-2 leaves conflicting or secret-bearing MCP declarations unresolved without echoing them", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".mcp.json",
        value: {
          mcpServers: {
            "token=supersecret-name": { command: "node" },
            unsafe: { url: "https://mcp.acme.test/api?token=supersecret-url" },
            search: { command: "first-private-command" },
          },
        },
      },
      {
        path: ".windsurf/mcp_config.json",
        value: { mcpServers: { search: { command: "second-private-command" } } },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_server_name_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_conflict"));
  assert.equal(result.resources.some((item) => item.record.kind === "mcp_server"), false);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|first-private-command|second-private-command/i);
});

test("HLG-2 bounds MCP declaration count before candidate construction", (t) => {
  const mcpServers = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [
    `server-${String(index).padStart(3, "0")}`,
    { command: "node", args: [`server-${index}.mjs`] },
  ]));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: ".mcp.json", value: { mcpServers } },
      { path: "server.json", value: { name: "unrelated-server", port: 8080 } },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "mcp_server").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "depends_on").length, 128);
});

test("HLG-2 discovers exact CI, container artifact, and Compose deployment candidates without retaining declaration bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".github/workflows/release.yml",
        raw: true,
        value: `name: Release
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo supersecret-github-command
`,
      },
      {
        path: ".gitlab-ci.yml",
        raw: true,
        value: `build:
  script:
    - echo supersecret-gitlab-command
`,
      },
      {
        path: ".circleci/config.yml",
        raw: true,
        value: `version: 2.1
jobs:
  build:
    docker:
      - image: private.example.test/supersecret-circle-image
    steps:
      - checkout
`,
      },
      {
        path: ".buildkite/pipeline.yaml",
        raw: true,
        value: `steps:
  - command: echo supersecret-buildkite-command
`,
      },
      {
        path: "Jenkinsfile",
        raw: true,
        value: `pipeline {
  stages { stage('Build') { steps { sh 'echo supersecret-jenkins-command' } } }
}
`,
      },
      {
        path: "Dockerfile",
        raw: true,
        value: `FROM node:24-alpine
ARG PRIVATE_BUILD_VALUE=supersecret-docker-argument
RUN echo "$PRIVATE_BUILD_VALUE"
`,
      },
      {
        path: "deploy/compose.yaml",
        raw: true,
        value: `services:
  api:
    image: private.example.test/supersecret-compose-image
    environment:
      PASSWORD: supersecret-compose-password
`,
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const delivery = first.resources.filter((item) => ["pipeline", "artifact", "deployment_target"].includes(item.record.kind));
  assert.deepEqual(delivery.map((item) => item.record.id), [
    "artifact:container-image/Dockerfile",
    "deployment_target:docker-compose/deploy/compose.yaml",
    "pipeline:buildkite/.buildkite/pipeline.yaml",
    "pipeline:circleci/.circleci/config.yml",
    "pipeline:github-actions/.github/workflows/release.yml",
    "pipeline:gitlab-ci/.gitlab-ci.yml",
    "pipeline:jenkins/Jenkinsfile",
  ]);
  assert.deepEqual(first.issues, []);
  assert.equal(first.relationships.filter((item) => item.record.type === "builds").length, 1);
  assert.equal(first.relationships.filter((item) => item.record.type === "deploys").length, 1);
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("pipeline:")).length, 5);
  assert.ok(delivery.every((item) => item.authority === "candidate"));
  assert.ok(delivery.every((item) => item.evidence.length === 1));
  assert.ok(delivery.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.ok(delivery.every((item) => ["ci_declaration", "deployment_declaration"].includes(item.evidence[0]!.kind)));
  assert.doesNotMatch(JSON.stringify(first), /supersecret|PRIVATE_BUILD_VALUE|PASSWORD/i,
    "commands, images, arguments, and environment values never enter the candidate fragment");

  writeFileSync(join(root, "Dockerfile"), "FROM changed-working-copy\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree delivery edits cannot alter exact-revision discovery");
});

test("HLG-2 reports malformed, oversized, and secret-bearing delivery declarations without echoing unsafe content", (t) => {
  const oversized = `jobs:\n  build:\n    steps:\n${"      - run: echo bounded\n".repeat(12_000)}`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: ".github/workflows/broken.yml", raw: true, value: "jobs: [unterminated" },
      { path: ".github/workflows/token=supersecret-path.yml", raw: true, value: "jobs:\n  safe: {}\n" },
      { path: ".circleci/config.yml", raw: true, value: oversized },
      { path: "Dockerfile", raw: true, value: "RUN echo no-base-image\n" },
      { path: "compose.yml", raw: true, value: "volumes: {}\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => ["pipeline", "artifact", "deployment_target"].includes(item.record.kind)), false);
  assert.equal(result.issues.filter((issue) => issue.code === "delivery_declaration_invalid").length, 3);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret-path|unterminated|no-base-image/i);
});

test("HLG-2 bounds delivery declaration count before blob hydration and candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `.github/workflows/workflow-${String(index).padStart(3, "0")}.yml`,
    value: `jobs:\n  build-${index}:\n    runs-on: ubuntu-latest\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "pipeline").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("pipeline:")).length, 128);
});

test("HLG-2 never follows a delivery declaration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  symlinkSync("package.json", join(root, "Dockerfile"));
  git(root, "add", "--", "Dockerfile");
  git(root, "commit", "-qm", "add delivery symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_mode" && issue.sourcePath === "Dockerfile"));
  assert.equal(result.resources.some((item) => item.record.kind === "artifact"), false);
});
