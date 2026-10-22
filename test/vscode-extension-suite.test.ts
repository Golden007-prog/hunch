import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The VS Code extension has no node_modules of its own; its unit tests run on the
// root's tsx through its own `npm test`. Bridging it here puts it under the root
// suite (and so under the release gate CI runs) without a separate workflow step.
const EXT_ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "vscode-extension");

test("the VS Code extension's own test script passes", () => {
  const script = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8")).scripts?.test as string | undefined;
  assert.equal(script, "node ../tooling/run-tests.mjs test/*.test.mts");
  const run = spawnSync(process.execPath, ["../tooling/run-tests.mjs", "test/*.test.mts"], {
    cwd: EXT_ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-4000));
});
