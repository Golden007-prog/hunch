import { cleanupDir, trustTeamStoreAs } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import type { Decision } from "../src/core/types.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { hunchCliArgs } from "./cli-invocation.js";
// The policy tools are a specialist MCP group; the everyday default hides them (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

const NOW = "2026-07-10T10:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, actor: string, sandbox: string): void {
  const hooks = join(sandbox, `${actor.toLowerCase()}-hooks`);
  mkdirSync(hooks, { recursive: true });
  git(root, "config", "user.name", actor);
  git(root, "config", "user.email", `${actor.toLowerCase()}@sync-gap.test`);
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", hooks);
}

type Actor = { name: string; root: string; env: NodeJS.ProcessEnv };

function cloneActor(sandbox: string, codeRemote: string, name: string): Actor {
  const root = join(sandbox, name.toLowerCase());
  const home = join(sandbox, `${name.toLowerCase()}-home`);
  mkdirSync(home, { recursive: true });
  git(sandbox, "clone", "-q", codeRemote, root);
  configureRepo(root, name, sandbox);
  return {
    name,
    root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@sync-gap.test`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@sync-gap.test`,
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      HUNCH_EMBEDDINGS: "off",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      CI: "1",
    },
  };
}

function expectCli(actor: Actor, args: string[]): string {
  const run = spawnSync(process.execPath, hunchCliArgs(...args), {
    cwd: actor.root,
    env: actor.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, out);
  return out;
}

async function mcpResult(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await client.callTool({ name, arguments: args });
  const payload = response.content.find((part): part is { type: "text"; text: string } => part.type === "text");
  assert.ok(payload, `${name} returned no text payload`);
  return { isError: response.isError === true, text: payload.text };
}

// A valid compiled policy record, produced by the real compiler in a scratch repo.
function compiledPolicyRecord(sandbox: string): { id: string; json: string } {
  const root = join(sandbox, "policy-source");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/services"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  git(sandbox, "init", "-q", root);
  configureRepo(root, "PolicySource", sandbox);
  writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u){ return dbQuery(u); }\n');
  writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture: layered orders");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    const decision: Decision = {
      id: "dec_sync_gap",
      title: "Order controllers must use OrderService for persistence",
      topic: "orders.controller-db-boundary",
      status: "accepted",
      context: "A direct controller-to-DB optimization reintroduced the N+1 incident.",
      decision: "Controllers reach persistence through the service boundary.",
      consequences: [],
      alternatives_rejected: ["Direct database access from controllers."],
      rejected_tripwires: [],
      related_components: [],
      related_files: ["src/api/orders.ts", "src/services/orders.ts", "src/db/client.ts"],
      supersedes: null,
      superseded_by: null,
      caused_by_bug: null,
      commit: null,
      valid_from: NOW,
      valid_to: null,
      retired: { symbols: [], deps: [] },
      conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-sync-gap"] },
      date: NOW,
    };
    store.json.put("decisions", decision);
    store.reindex();
    const policy = new ConstitutionService(store, root).compile("dec_sync_gap", { through: "fetchOrders", now: NOW });
    assert.equal(policy.proof ?? null, null, "fixture policy is an unproved candidate");
    return { id: policy.id, json: readFileSync(join(root, ".hunch", "policies", `${policy.id}.json`), "utf8") };
  } finally {
    store.close();
  }
}

// Team sync gap: a teammate's long-lived MCP whose ordinary pulls are in failure
// backoff must not report a just-pushed policy as "not found". An exact policy
// miss bypasses the backoff once (like hunch_current_decision), and abstains
// explicitly when the shared store cannot be refreshed.
test("team policy reads confirm a local miss against fresh shared memory despite pull backoff", { timeout: 300_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-policy-sync-gap-"));
  let client: Client | undefined;
  try {
    const memorySeed = join(sandbox, "memory-seed");
    const memoryRemote = join(sandbox, "memory.git");
    mkdirSync(memorySeed, { recursive: true });
    git(memorySeed, "init", "-q", "-b", "main");
    configureRepo(memorySeed, "MemorySeed", sandbox);
    writeFileSync(join(memorySeed, "README.md"), "# team memory\n");
    git(memorySeed, "add", "README.md");
    git(memorySeed, "commit", "-qm", "seed: shared memory repository");
    git(sandbox, "clone", "-q", "--bare", memorySeed, memoryRemote);

    const codeSeed = join(sandbox, "code-seed");
    const codeRemote = join(sandbox, "code.git");
    mkdirSync(join(codeSeed, "src"), { recursive: true });
    git(codeSeed, "init", "-q", "-b", "main");
    configureRepo(codeSeed, "CodeSeed", sandbox);
    writeFileSync(join(codeSeed, "src/orders.ts"), "export const orders = () => [];\n");
    git(codeSeed, "add", "src/orders.ts");
    git(codeSeed, "commit", "-qm", "feat: tiny orders service");
    git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);

    const architect = cloneActor(sandbox, codeRemote, "Architect");
    expectCli(architect, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
    expectCli(architect, ["shared", "--repo", memoryRemote, "--no-hook"]);
    git(architect.root, "add", "-A");
    git(architect.root, "commit", "-qm", "chore: connect team memory");
    git(architect.root, "push", "-q", "origin", "main");

    const developer = cloneActor(sandbox, codeRemote, "Developer");
    trustTeamStoreAs(developer.env, developer.root);
    expectCli(developer, [
      "record-constraint", "SYNC_GAP_FIRST_WRITE: wire the developer to shared memory",
      "--scope", "src/orders.ts", "--severity", "warning", "--type", "correctness",
    ]);

    // The teammate's policy, staged in a separate memory clone and pushed later.
    const policy = compiledPolicyRecord(sandbox);
    const staging = join(sandbox, "teammate-memory");
    git(sandbox, "clone", "-q", memoryRemote, staging);
    configureRepo(staging, "Teammate", sandbox);
    mkdirSync(join(staging, ".hunch", "policies"), { recursive: true });
    writeFileSync(join(staging, ".hunch", "policies", `${policy.id}.json`), policy.json);
    git(staging, "add", "-A");
    git(staging, "commit", "-qm", "hunch: compile policy");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: hunchCliArgs("mcp"),
      cwd: developer.root,
      env: developer.env,
    });
    client = new Client({ name: "sync-gap-developer", version: "1.0.0" });
    await client.connect(transport);
    const before = await mcpResult(client, "hunch_policy_proof", { policy_id: policy.id });
    assert.equal(before.isError, true, before.text);
    assert.match(before.text, new RegExp(`policy ${policy.id} not found`),
      "with a fresh shared store a confirmed miss keeps the ordinary not-found error");

    // Transient remote failure: every exact miss force-pulls, fails, and deepens the
    // ordinary request backoff (1s, 2s, 4s, 8s), while abstaining explicitly.
    const remoteObjects = join(memoryRemote, "objects");
    const unavailableObjects = join(memoryRemote, "objects.transiently-unavailable");
    renameSync(remoteObjects, unavailableObjects);
    try {
      for (let i = 0; i < 4; i++) {
        const abstained = await mcpResult(client, "hunch_policy_card", { policy_id: policy.id });
        assert.equal(abstained.isError, true, abstained.text);
        assert.match(abstained.text, /cannot confirm that policy \S+ is absent from shared team memory/);
        assert.match(abstained.text, /Retry/);
        assert.doesNotMatch(abstained.text, /not found/);
      }
    } finally {
      renameSync(unavailableObjects, remoteObjects);
    }

    // The teammate pushes while this MCP's ordinary pulls are still in backoff.
    git(staging, "push", "-q", "origin", "main");
    const proof = await mcpResult(client, "hunch_policy_proof", { policy_id: policy.id });
    assert.equal(proof.isError, false, proof.text);
    assert.match(proof.text, new RegExp(`Policy ${policy.id} has no proof yet`),
      "the long-lived teammate MCP must see the just-pushed policy despite pull backoff");
  } finally {
    await client?.close().catch(() => undefined);
    cleanupDir(sandbox);
  }
});
