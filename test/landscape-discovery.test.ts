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

test("HLG-2 discovers exact OpenAPI YAML and Swagger JSON contracts without retaining operation bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "contracts/openapi.yaml",
        raw: true,
        value: `openapi: 3.1.0
info:
  title: Payments API
  version: 2026-08-26
paths:
  /payments:
    post:
      description: supersecret-operation-description
      x-private-command: never-retain-this-body
`,
      },
      {
        path: "legacy/petstore.swagger.json",
        value: {
          swagger: "2.0",
          info: { title: "Legacy Petstore", version: "1.0.0" },
          paths: { "/animals": { get: { description: "supersecret-legacy-operation" } } },
        },
      },
      {
        path: "contracts/api.yaml",
        raw: true,
        value: "openapi: 3.1.0\ninfo:\n  title: intentionally outside the fixed filename family\n",
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const apis = first.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:openapi/contracts/openapi.yaml",
    "api:openapi/legacy/petstore.swagger.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["3.1.0", "2.0"]);
  assert.deepEqual(apis.map((item) => item.record.metadata.api_dialect), ["openapi", "swagger"]);
  assert.deepEqual(apis.map((item) => item.evidence[0]!.sourceField), ["openapi", "swagger"]);
  assert.ok(apis.every((item) => item.evidence[0]!.kind === "api_declaration"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:")).length, 2);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /supersecret|never-retain-this-body|\/payments|\/animals/i,
    "titles, paths, operations, and extension bodies never enter the candidate fragment");

  writeFileSync(join(root, "contracts/openapi.yaml"), "openapi: 3.0.0\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree API edits cannot alter exact-revision discovery");
});

test("HLG-2 discovers exact AsyncAPI 2/3 contracts without retaining channels, operations, or servers", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/events", repository: "https://github.com/acme/events.git" },
    files: [
      {
        path: "contracts/asyncapi.yaml",
        raw: true,
        value: `asyncapi: 3.0.0
info:
  title: Private Event Mesh
  version: 1.0.0
servers:
  production:
    host: token=never-retain.example.test
channels:
  secret-orders:
    address: private-orders-stream
operations:
  consumeSecretOrders:
    action: receive
`,
      },
      {
        path: "contracts/legacy.orders.asyncapi.json",
        value: {
          asyncapi: "2.6.0",
          info: { title: "Legacy Orders", version: "1.0.0" },
          channels: { "private/orders": { subscribe: { operationId: "neverRetainLegacyOperation" } } },
        },
      },
      {
        path: "contracts/events.yaml",
        raw: true,
        value: "asyncapi: 3.0.0\ninfo:\n  title: outside the fixed filename family\n",
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:asyncapi/contracts/asyncapi.yaml",
    "api:asyncapi/contracts/legacy.orders.asyncapi.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["3.0.0", "2.6.0"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "asyncapi"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "asyncapi"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:asyncapi/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /never-retain|neverRetain|secret-orders|private-orders|private\/orders/i);
});

test("HLG-2 rejects unsupported, duplicate, and mixed AsyncAPI identities without echoing bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/events", repository: "https://github.com/acme/events.git" },
    files: [
      { path: "contracts/future.asyncapi.yaml", raw: true, value: "asyncapi: 4.0.0\ninfo:\n  title: future-private-title\n" },
      { path: "contracts/mixed.asyncapi.json", value: { asyncapi: "3.0.0", openapi: "3.1.0", private: "mixed-private-body" } },
      { path: "contracts/duplicate.asyncapi.json", raw: true, value: "{\"asyncapi\":\"2.6.0\",\"asyncapi\":\"3.0.0\",\"private\":\"duplicate-private-body\"}" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 3);
  assert.doesNotMatch(JSON.stringify(result), /future-private|mixed-private|duplicate-private/i);
});

test("HLG-2 discovers proto2/proto3 contracts without retaining messages, fields, services, or options", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/rpc", repository: "https://github.com/acme/rpc.git" },
    files: [
      {
        path: "proto/payments.proto",
        raw: true,
        value: `// committed contract, not runtime proof
syntax = "proto3";
package private.payments.v1;
option java_package = "token.never.retain";
message SecretPayment { string private_card = 1; }
service PaymentsService { rpc Charge(SecretPayment) returns (SecretPayment); }
`,
      },
      {
        path: "proto/legacy/orders.proto",
        raw: true,
        value: `/* legacy contract */
syntax="proto2";
package private.legacy;
message LegacyOrder { required string never_retain_field = 1; }
`,
      },
      {
        path: "proto/ignored.proto.txt",
        raw: true,
        value: "syntax = \"proto3\";\nmessage OutsideFixedExtension {}\n",
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:protobuf/proto/legacy/orders.proto",
    "api:protobuf/proto/payments.proto",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["proto2", "proto3"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "protobuf"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "syntax"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:protobuf/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|card|Charge|never_retain|token\.never/i);
});

test("HLG-2 rejects missing, unsupported, duplicated, and structurally unclosed protobuf headers", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/rpc", repository: "https://github.com/acme/rpc.git" },
    files: [
      { path: "proto/missing.proto", raw: true, value: "package private.missing;\nmessage NeverRetain {}\n" },
      { path: "proto/unsupported.proto", raw: true, value: "edition = \"2023\";\nmessage PrivateEdition {}\n" },
      { path: "proto/duplicate.proto", raw: true, value: "syntax = \"proto3\";\nsyntax = \"proto2\";\nmessage PrivateDuplicate {}\n" },
      { path: "proto/late.proto", raw: true, value: "package private.first;\nsyntax = \"proto3\";\nmessage PrivateLate {}\n" },
      { path: "proto/unclosed.proto", raw: true, value: "syntax = \"proto3\";\nmessage PrivateUnclosed { string secret = 1;\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 5);
  assert.doesNotMatch(JSON.stringify(result), /NeverRetain|PrivateEdition|PrivateDuplicate|PrivateLate|PrivateUnclosed|secret/i);
});

test("HLG-2 discovers fixed-name JSON Schema dialects without retaining IDs, properties, examples, or bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/contracts", repository: "https://github.com/acme/contracts.git" },
    files: [
      {
        path: "schemas/payment.schema.json",
        value: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://token=never-retain.example.test/private/payment",
          title: "Private Payment",
          properties: { secretCard: { type: "string", examples: ["never-retain-example"] } },
        },
      },
      {
        path: "schemas/legacy.schema.json",
        value: {
          $schema: "http://json-schema.org/draft-07/schema#",
          definitions: { PrivateOrder: { type: "object" } },
        },
      },
      {
        path: "schemas/schema.yaml",
        raw: true,
        value: "$schema: https://json-schema.org/draft/2020-12/schema\ntitle: ignored non-JSON family\n",
      },
      {
        path: "schemas/arbitrary.json",
        value: { $schema: "https://json-schema.org/draft/2020-12/schema", title: "ignored fixed-name miss" },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:json-schema/schemas/legacy.schema.json",
    "api:json-schema/schemas/payment.schema.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["draft-07", "2020-12"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "jsonschema"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "$schema"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:json-schema/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /never-retain|secretCard|PrivateOrder|token=|Private Payment/i);
});

test("HLG-2 rejects unsupported, duplicate, and mixed JSON Schema identities without echoing bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/contracts", repository: "https://github.com/acme/contracts.git" },
    files: [
      { path: "schemas/old.schema.json", value: { $schema: "http://json-schema.org/draft-04/schema#", private: "old-private-body" } },
      { path: "schemas/mixed.schema.json", value: { $schema: "https://json-schema.org/draft/2020-12/schema", openapi: "3.1.0", private: "mixed-private-body" } },
      { path: "schemas/duplicate.schema.json", raw: true, value: "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$schema\":\"https://json-schema.org/draft/2019-09/schema\",\"private\":\"duplicate-private-body\"}" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 3);
  assert.doesNotMatch(JSON.stringify(result), /old-private|mixed-private|duplicate-private/i);
});

test("HLG-2 discovers committed Prisma migration artifacts without retaining SQL bodies or inferring a database", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "prisma/migrations/20260826090000_initial/migration.sql",
        raw: true,
        value: "CREATE TABLE PrivateCustomer (secret_card TEXT);\n",
      },
      {
        path: "packages/billing/prisma/migrations/20260826100000_add_invoice/migration.sql",
        raw: true,
        value: "ALTER TABLE PrivateInvoice ADD COLUMN hidden_token TEXT;\n",
      },
      { path: "prisma/migrations/migration_lock.toml", raw: true, value: "provider = \"postgresql\"\n" },
      { path: "db/migrations/20260826_not_prisma.sql", raw: true, value: "SELECT 'ignored-private-body';\n" },
      { path: "prisma/migrations/20260826110000_wrong/custom.sql", raw: true, value: "SELECT 'ignored-custom-body';\n" },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const migrations = first.resources.filter((item) => item.record.metadata.artifact_type === "database_migration");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/prisma/packages/billing/prisma/migrations/20260826100000_add_invoice/migration.sql",
    "artifact:migration/prisma/prisma/migrations/20260826090000_initial/migration.sql",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), [
    "20260826100000_add_invoice",
    "20260826090000_initial",
  ]);
  assert.ok(migrations.every((item) => item.record.kind === "artifact"));
  assert.ok(migrations.every((item) => item.record.metadata.migration_framework === "prisma"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceField === "path"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("artifact:migration/prisma/")).length, 2);
  assert.equal(first.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /PrivateCustomer|secret_card|PrivateInvoice|hidden_token|ignored-private|ignored-custom/i);

  writeFileSync(join(root, "prisma/migrations/20260826090000_initial/migration.sql"), "DROP PRIVATE WORKING COPY;\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree migration edits cannot alter exact-revision discovery");
});

test("HLG-2 rejects empty and oversized Prisma migrations without echoing SQL bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "prisma/migrations/20260826090000_empty/migration.sql", raw: true, value: "  \n\t" },
      {
        path: "prisma/migrations/20260826100000_oversized/migration.sql",
        raw: true,
        value: `-- private migration body\n${"SELECT 'never-retain-oversized';\n".repeat(40_000)}`,
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_oversized"));
  assert.doesNotMatch(JSON.stringify(result), /never-retain-oversized|private migration body/i);
});

test("HLG-2 rejects non-UTF-8 Prisma migration data without returning its bytes", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  const migrationPath = "prisma/migrations/20260826103000_binary/migration.sql";
  const target = join(root, migrationPath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, Buffer.from([0xff, 0xfe, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]));
  git(root, "add", "--", migrationPath);
  git(root, "commit", "-qm", "add invalid migration bytes");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_invalid"
    && issue.sourcePath === migrationPath));
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/i);
});

test("HLG-2 bounds Prisma migration count before candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `prisma/migrations/20260826${String(index).padStart(6, "0")}_bounded/migration.sql`,
    value: "SELECT 1;\n",
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.metadata.artifact_type === "database_migration").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/prisma/")).length, 128);
});

test("HLG-2 discovers standard Flyway versioned, undo, and repeatable migrations without retaining SQL", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "src/main/resources/db/migration/V1__initial.sql",
        raw: true,
        value: "CREATE TABLE PrivateAccount (hidden_password TEXT);\n",
      },
      {
        path: "db/migration/V2_1__add_invoice.sql",
        raw: true,
        value: "ALTER TABLE PrivateInvoice ADD COLUMN secret_token TEXT;\n",
      },
      {
        path: "db/migration/U2_1__undo_invoice.sql",
        raw: true,
        value: "DROP TABLE NeverRetainUndo;\n",
      },
      {
        path: "db/migration/R__refresh_views.sql",
        raw: true,
        value: "CREATE VIEW PrivateRevenue AS SELECT hidden_total;\n",
      },
      { path: "db/migration/v3__lowercase.sql", raw: true, value: "SELECT 'ignored-lowercase';\n" },
      { path: "db/migration/V3_missing_separator.sql", raw: true, value: "SELECT 'ignored-separator';\n" },
      { path: "db/migration/nested/V4__nested.sql", raw: true, value: "SELECT 'ignored-nested';\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "flyway");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/flyway/db/migration/R__refresh_views.sql",
    "artifact:migration/flyway/db/migration/U2_1__undo_invoice.sql",
    "artifact:migration/flyway/db/migration/V2_1__add_invoice.sql",
    "artifact:migration/flyway/src/main/resources/db/migration/V1__initial.sql",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.metadata.migration_type), [
    "repeatable",
    "undo",
    "versioned",
    "versioned",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), [undefined, "2_1", "2_1", "1"]);
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/flyway/")).length, 4);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /PrivateAccount|hidden_password|PrivateInvoice|secret_token|NeverRetainUndo|PrivateRevenue|hidden_total|ignored-/i);
});

test("HLG-2 reports malformed, unsupported, oversized, and unsafe OpenAPI declarations without echoing content", (t) => {
  const oversized = `openapi: 3.1.0\ninfo:\n  description: |\n${"    bounded declaration data\n".repeat(40_000)}`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "contracts/broken.openapi.yaml", raw: true, value: "openapi: 3.1.0\ninfo: [unterminated-private-value" },
      { path: "contracts/future.openapi.yaml", raw: true, value: "openapi: 4.0.0\ninfo:\n  title: unsupported-private-value\n" },
      { path: "contracts/ambiguous.openapi.json", value: { openapi: "3.1.0", swagger: "2.0", private: "do-not-retain" } },
      { path: "contracts/duplicate.openapi.json", raw: true, value: "{\"openapi\":\"3.0.0\",\"openapi\":\"3.1.0\",\"private\":\"duplicate-private-value\"}" },
      { path: "contracts/token=supersecret.openapi.yaml", raw: true, value: "openapi: 3.1.0\n" },
      { path: "contracts/oversized.openapi.yaml", raw: true, value: oversized },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 4);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret|unterminated-private|unsupported-private|do-not-retain|duplicate-private/i);
});

test("HLG-2 bounds OpenAPI declaration count before blob hydration and candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `contracts/service-${String(index).padStart(3, "0")}.openapi.yaml`,
    value: `openapi: 3.1.0\ninfo:\n  title: Service ${index}\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "api").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:")).length, 128);
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

test("HLG-2 discovers structured Kubernetes workloads and systemd units without retaining operational bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "k8s/workloads.yaml",
        raw: true,
        value: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    spec:
      containers:
        - name: api
          image: private.example.test/supersecret-kubernetes-image
          env:
            - name: PASSWORD
              value: supersecret-kubernetes-password
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: reconcile
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: job
              image: private.example.test/supersecret-cron-image
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: intentionally-not-a-workload
data:
  private-value: supersecret-config-value
`,
      },
      {
        path: "systemd/hunch-worker.service",
        raw: true,
        value: `[Unit]
Description=Hunch worker

[Service]
Environment=ACCESS_TOKEN=supersecret-systemd-value
ExecStart=/private/path/hunch-worker --private-argument
`,
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const targets = first.resources.filter((item) => item.record.kind === "deployment_target");
  assert.deepEqual(targets.map((item) => item.record.id), [
    "deployment_target:kubernetes/k8s/workloads.yaml#apps/v1/deployment/payments/payments-api",
    "deployment_target:kubernetes/k8s/workloads.yaml#batch/v1/cronjob/default/reconcile",
    "deployment_target:systemd/systemd/hunch-worker.service",
  ]);
  assert.deepEqual(targets.map((item) => item.record.contract_version), ["apps/v1", "batch/v1", undefined]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.record.metadata.kubernetes_kind), ["Deployment", "CronJob"]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.record.metadata.kubernetes_namespace), ["payments", "default"]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.evidence[0]!.sourceField), [
    "documents[0].metadata.name",
    "documents[1].metadata.name",
  ]);
  assert.equal(first.relationships.filter((item) => item.record.type === "deploys").length, 3);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /supersecret|ACCESS_TOKEN|PASSWORD|private-argument|private\/path/i,
    "images, commands, environment values, and non-workload data never enter the candidate fragment");

  writeFileSync(join(root, "k8s/workloads.yaml"), "apiVersion: v1\nkind: Pod\nmetadata:\n  name: changed-working-copy\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree Kubernetes changes cannot alter exact-revision discovery");
});

test("HLG-2 leaves unsafe, malformed, templated, and duplicate deployment identities unresolved", (t) => {
  const duplicate = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: duplicate-api
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: duplicate-api
`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "k8s/broken.yaml", raw: true, value: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: [unterminated" },
      { path: "k8s/duplicate.yaml", raw: true, value: duplicate },
      { path: "k8s/templated.yaml", raw: true, value: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Values.privateName }}\n" },
      { path: "k8s/configmap.yaml", raw: true, value: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: safe-config\n" },
      { path: "systemd/broken.service", raw: true, value: "[Unit]\nDescription=No service section\n" },
      { path: "systemd/token=supersecret-path.service", raw: true, value: "[Service]\nExecStart=/safe/path\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "deployment_target"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "delivery_declaration_invalid").length, 3);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_conflict"));
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret-path|privateName|unterminated/i);
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

test("HLG-2 bounds logical workloads when one Kubernetes file contains more than the declaration cap", (t) => {
  const workloads = Array.from({ length: 129 }, (_, index) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: workload-${String(index).padStart(3, "0")}
`).join("---\n");
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [{ path: "k8s/workloads.yaml", raw: true, value: workloads }],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "deployment_target").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "deploys").length, 128);
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

test("HLG-2 never follows an OpenAPI declaration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  mkdirSync(join(root, "contracts"), { recursive: true });
  symlinkSync("../package.json", join(root, "contracts/openapi.yaml"));
  git(root, "add", "--", "contracts/openapi.yaml");
  git(root, "commit", "-qm", "add OpenAPI symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_mode"
    && issue.sourcePath === "contracts/openapi.yaml"));
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
});

test("HLG-2 never follows a Prisma migration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  const migrationDir = join(root, "prisma/migrations/20260826120000_linked");
  mkdirSync(migrationDir, { recursive: true });
  symlinkSync("../../../package.json", join(migrationDir, "migration.sql"));
  git(root, "add", "--", "prisma/migrations/20260826120000_linked/migration.sql");
  git(root, "commit", "-qm", "add Prisma migration symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_mode"
    && issue.sourcePath === "prisma/migrations/20260826120000_linked/migration.sql"));
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
});
