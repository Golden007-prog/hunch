import {
  correctionStagePathPattern,
  inferIssueCorrectionStage,
} from "../core/correctionStage.js";
import type { ContractAxisOwnerSource } from "../core/pipeline.js";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { repoSourceInventory } from "./repoSource.js";

const SOURCE_FILE_LIMIT = 4_000;
const SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;

export interface CorrectionSourceCollection {
  sources: ContractAxisOwnerSource[];
  files_read: number;
  bytes_read: number;
  files_skipped: number;
}

/** Safely read a bounded working-tree TypeScript corpus. Stage-relevant paths
 * are read first so a huge repository cannot crowd the likely correction layer
 * out of the fixed source budget. */
export function collectCorrectionStageSources(root: string, issue: string): CorrectionSourceCollection {
  const pattern = correctionStagePathPattern(inferIssueCorrectionStage(issue), issue);
  const eligible = repoSourceInventory(root, { kind: "working" }).entries
    .filter((entry) => /^[A-Za-z0-9._/-]+\.tsx?$/.test(entry.path)
      && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.test\.tsx?$/.test(entry.path))
    .sort((a, b) => Number(pattern.test(b.path)) - Number(pattern.test(a.path)) || compareCodeUnits(a.path, b.path));
  const attempted = eligible.slice(0, SOURCE_FILE_LIMIT);
  const sources: ContractAxisOwnerSource[] = [];
  let bytesRead = 0;
  let filesSkipped = eligible.length - attempted.length;
  for (const entry of attempted) {
    const read = entry.read();
    if (read.source === null) {
      filesSkipped++;
      continue;
    }
    const bytes = Buffer.byteLength(read.source, "utf8");
    if (bytesRead + bytes > SOURCE_BYTE_LIMIT) {
      filesSkipped++;
      continue;
    }
    sources.push({ path: entry.path, content: read.source });
    bytesRead += bytes;
  }
  return {
    sources,
    files_read: sources.length,
    bytes_read: bytesRead,
    files_skipped: filesSkipped,
  };
}
