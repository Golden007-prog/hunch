/** Durable file writes for the Hunch. */
import { closeSync, fsyncSync, linkSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let counter = 0;
const renameRetryDelaysMs = [10, 20, 40, 80] as const;
const renameRetryWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Write `data` to `file` via a temp file + rename, so an interrupted write can't
 * leave the target truncated (the symbols/edges index is the worst to half-write).
 *
 * Durability (issue #34): the temp file is fsync'd BEFORE the rename, and the
 * parent directory best-effort after it. A process kill was always safe (page
 * cache preserves ordering), but on power loss / OS crash the rename's metadata
 * could reach disk before the temp file's data blocks — leaving the target
 * present but truncated or garbage, the exact state the atomic-write invariant
 * (con_902759b3dc) exists to prevent.
 *
 * Windows caveat: renameSync can't REPLACE a file another process holds open (even
 * for read) — it throws EPERM/EBUSY/EACCES, exactly when the MCP server is reading
 * while a CLI writes. Retry that atomic replacement with bounded backoff. If the
 * contention persists, fail with the old target untouched; never trade availability
 * for a direct write that an interruption could truncate. Failed writes clean up the
 * temporary file.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp${process.pid}.${counter++}`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd); // data blocks reach disk before the rename's metadata can
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    cleanupTmp(tmp);
    throw e;
  }
  try {
    renameWithContentionRetry(tmp, file);
  } catch (e) {
    cleanupTmp(tmp);
    throw e;
  }
  fsyncDirBestEffort(dirname(file));
}

/** Persist the rename itself (the directory entry). POSIX semantics; Windows
 *  cannot open directories for fsync, so this is a silent no-op there — NTFS
 *  journals the metadata on its own schedule. */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* platform without directory fsync — best effort by contract */ }
}

function renameWithContentionRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delayMs = renameRetryDelaysMs[attempt];
      if (delayMs === undefined || !isRenameContention(error)) throw error;
      Atomics.wait(renameRetryWaiter, 0, 0, delayMs);
    }
  }
}

function isRenameContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Atomically create a complete file only when no target exists. A same-dir
 * hard link publishes the fully written temp inode with create-if-absent
 * semantics, so concurrent lifecycle writers can never be overwritten. */
export function writeFileAtomicIfAbsent(file: string, data: string): boolean {
  const tmp = `${file}.tmp${process.pid}.${counter++}`;
  try {
    writeFileAtomicTmp(tmp, data);
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    // Not silently best-effort (issue #38): after linkSync succeeds the target
    // shares the temp inode, so a swallowed unlink failure (a Windows AV scanner
    // or indexer briefly holding tmp) leaves the published file with nlink=2 —
    // which validateExistingFile rejects as hard-linked — plus a stray .tmp.
    cleanupTmp(tmp);
  }
}

/** Write + fsync a fresh temp file (shared by both atomic writers). */
function writeFileAtomicTmp(tmp: string, data: string): void {
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Remove a temp file, riding out a transient external hold (AV/indexer) with one
 *  short retry; a persistent failure is REPORTED, never swallowed — a leaked tmp
 *  beside a hard-link-published target keeps that target at nlink=2. */
function cleanupTmp(p: string): void {
  try {
    rmSync(p, { force: true });
    return;
  } catch { /* transient hold — retry once below */ }
  Atomics.wait(renameRetryWaiter, 0, 0, 50);
  try {
    rmSync(p, { force: true });
  } catch (e) {
    console.warn(`[hunch] temp file left behind (its published target keeps nlink=2 until it is removed): ${p} (${(e as Error).message})`);
  }
}
