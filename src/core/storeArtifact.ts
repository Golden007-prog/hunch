import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRepoFileReader } from "./safeRepoFile.js";

/** Containment for store artifacts outside JsonStore's entity registry (ledgers,
 * policy proofs, and local audit logs). The explicitly selected store's parent
 * may have a platform alias, but no component inside that store may be a link. */
export function storeArtifactPath(hunchDir: string, ...parts: string[]): string {
  let path = resolve(hunchDir);
  let parent: string;
  try { parent = realpathSync(dirname(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parent = dirname(path);
  }
  let expected = join(parent, basename(path));
  const check = (directory: boolean): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() && !stat.isDirectory())
        || (stat.isFile() && stat.nlink !== 1) || realpathSync(path) !== expected) {
        throw new Error(`unsafe store artifact path ${path}: symlinks, hard links and special files are refused`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  check(true);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..") throw new Error("unsafe store artifact path component");
    path = join(path, part);
    expected = join(expected, part);
    check(index < parts.length - 1);
  }
  return path;
}

/** A missing artifact is distinct from an unsafe/unreadable artifact. Reuse the
 * scanner's bounded descriptor read; policy and ledger corruption must fail visibly. */
export function readStoreArtifact(hunchDir: string, parts: string[], maxBytes = 256 * 1024 * 1024): string | null {
  const file = storeArtifactPath(hunchDir, ...parts);
  try {
    if (!lstatSync(file).isFile()) throw new Error(`unsafe store artifact path ${file}: expected an ordinary file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const text = createRepoFileReader(dirname(resolve(hunchDir)), { maxBytes })(file);
  if (text === null) throw new Error(`unsafe or unreadable store artifact ${file}`);
  storeArtifactPath(hunchDir, ...parts);
  return text;
}
