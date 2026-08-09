/**
 * MCP registry manifest (server.json) — drift guards. The official registry
 * validates npm ownership by reading `mcpName` from the PUBLISHED package and
 * matching it against the server.json name, and installs the exact version the
 * manifest names. Any of these drifting from package.json ships a listing that
 * points at the wrong release (or fails validation at publish time), so the
 * suite pins them together: a release bump that forgets server.json fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string; version: string; mcpName?: string; files: string[];
};
const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
  name: string; version: string;
  packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string }; packageArguments?: Array<{ type: string; value: string }> }>;
};

test("server.json name matches package.json mcpName (registry ownership check)", () => {
  assert.ok(pkg.mcpName, "package.json must declare mcpName for registry npm validation");
  assert.equal(manifest.name, pkg.mcpName);
});

test("server.json versions track package.json exactly", () => {
  assert.equal(manifest.version, pkg.version);
  for (const p of manifest.packages) assert.equal(p.version, pkg.version);
});

test("the npm package entry launches the MCP server, not the bare CLI", () => {
  const npm = manifest.packages.find((p) => p.registryType === "npm");
  assert.ok(npm, "manifest must carry an npm package entry");
  assert.equal(npm!.identifier, pkg.name);
  assert.equal(npm!.transport.type, "stdio");
  const args = (npm!.packageArguments ?? []).map((a) => a.value);
  assert.deepEqual(args, ["mcp"], "launcher must pass the mcp subcommand");
});

test("server.json ships in the npm tarball", () => {
  assert.ok(pkg.files.includes("server.json"));
});
