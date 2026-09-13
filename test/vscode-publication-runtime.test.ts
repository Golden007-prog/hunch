import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Execute the shipped publication step in isolation, as Actions does. Earlier
// steps cannot supply lexical bindings to this separate Node process.
const workflow = readFileSync(".github/workflows/vscode-open-vsx.yml", "utf8");
const step = workflow.split("- name: Verify Open VSX converges and write publication receipt")[1]!;
const script = step.split("<<'NODE'\n")[1]!.split("\n          NODE")[0]!
  .replace(/^          /gm, "").replace(/^import .+;\n/gm, "");

function publication(mode: "converge" | "missing" | "wrong-bytes") {
  const bytes = Buffer.from("reviewed VSIX fixture");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const version = "0.18.2";
  const manifest = {
    extension: { publisher: "davesheffer", name: "hunch-vscode", version },
    artifact: { sha256: digest, entry_manifest_sha256: "entries" },
    content_hash: "candidate",
  };
  let requests = 0;
  const writes: string[] = [];
  const result = runInNewContext(`(async () => { ${script}\n })()`, {
    createHash, Buffer, URL, AbortSignal, resolve,
    process: { env: {
      EXTENSION_IDENTITY: "davesheffer.hunch-vscode", EXTENSION_VERSION: version,
      VSIX_SHA256: digest, ENTRY_MANIFEST_SHA256: "entries",
      OPEN_VSX_PREFLIGHT: "false", OPEN_VSX_PUBLISH_OUTCOME: "success",
    } },
    setTimeout: (callback: () => void) => callback(),
    readFileSync: () => Buffer.from(JSON.stringify(manifest)),
    mkdirSync: () => {},
    writeFileSync: (_path: string, data: string) => writes.push(data),
    fetch: async (url: string | URL) => {
      if (String(url).startsWith("https://open-vsx.org/api/")) {
        requests++;
        if (mode === "missing" || requests === 1) return { status: 404, ok: false };
        return { status: 200, ok: true, json: async () => ({
          namespace: "davesheffer", name: "hunch-vscode", version,
          files: { download: "https://example.test/reviewed.vsix" },
        }) };
      }
      return { ok: true, url: String(url), arrayBuffer: async () => mode === "wrong-bytes" ? Buffer.from("substituted") : bytes };
    },
  }) as Promise<void>;
  return { result, writes, requests: () => requests };
}

test("Open VSX publication script independently polls and writes exact-byte evidence", async () => {
  const run = publication("converge");
  await run.result;
  assert.equal(run.requests(), 2);
  assert.equal(run.writes.length, 1);
  const receipt = JSON.parse(run.writes[0]!);
  assert.equal(receipt.result, "converged");
  assert.equal(receipt.registries.open_vsx.attempts, 2);
  assert.equal(receipt.registries.open_vsx.asset_sha256, receipt.candidate.vsix_sha256);
});

test("Open VSX publication fails closed after bounded absence or substituted bytes", async () => {
  for (const mode of ["missing", "wrong-bytes"] as const) {
    const run = publication(mode);
    await assert.rejects(run.result, mode === "missing" ? /exact version not visible/ : /different VSIX bytes/);
    assert.equal(run.requests(), 36);
    assert.equal(run.writes.length, 0);
  }
});
