import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();
const SOURCE_CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const COMPILED_CLI = join(PROJECT_ROOT, "dist/cli/index.js");

/**
 * CI can prebuild once and exercise the exact shipped CLI without paying a
 * TypeScript transform for every black-box subprocess. Local and release-gate
 * runs keep the source CLI unless the caller explicitly opts into the build.
 */
export function hunchCliArgs(...args: string[]): string[] {
  if (process.env.HUNCH_TEST_COMPILED_CLI === "1") {
    assert.ok(existsSync(COMPILED_CLI), "HUNCH_TEST_COMPILED_CLI requires a fresh npm run build");
    return ["--enable-source-maps", COMPILED_CLI, ...args];
  }
  return [TSX, SOURCE_CLI, ...args];
}
