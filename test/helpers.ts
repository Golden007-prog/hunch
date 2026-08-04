import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { extracted, inferred, type Provenance } from "../src/core/types.js";

export function tempStore(): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-test-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);

/** Can this process create symlinks? Windows restricts symlink creation to
 *  elevated processes unless Developer Mode is on, so the symlink-hardening
 *  tests probe ONCE and skip honestly instead of dying in setup with EPERM.
 *  The guards under test stay fully exercised on POSIX and on CI. */
let symlinkCapability: boolean | undefined;
export function canSymlink(): boolean {
  if (symlinkCapability !== undefined) return symlinkCapability;
  const dir = mkdtempSync(join(tmpdir(), "hunch-symlink-probe-"));
  try {
    writeFileSync(join(dir, "t.txt"), "");
    symlinkSync(join(dir, "t.txt"), join(dir, "l.txt"), "file");
    symlinkCapability = true;
  } catch {
    symlinkCapability = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinkCapability;
}

/** `skip` option for tests that MUST create symlinks: false when available,
 *  else the reason string node:test prints. */
export const SYMLINK_SKIP: boolean | string =
  canSymlink() ? false : "symlink creation unavailable (Windows without Developer Mode/elevation)";
