import { StateRefusal } from "./stateError.js";
/** Partition identity and upgrade gate, re-read for every state operation. */
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { HunchStore } from './hunchStore.js';
import { hunchPaths } from '../core/paths.js';
import { ScopeSchema, PartitionDeclarationSchema, type Scope } from '../core/stateContract.js';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
export function partitionDeclarationOf(store: HunchStore): Scope & { required_capabilities?: string[] } {
  const declared = join(hunchPaths(store.publicRoot).hunch, "partition.json");
  if (existsSync(declared)) {
    const parsed = PartitionDeclarationSchema.safeParse(JSON.parse(readFileSync(declared, "utf8")));
    if (!parsed.success) throw new StateRefusal("unsupported", `${declared} does not declare a supported partition scope or capabilities`);
    return parsed.data;
  }
  const raw = basename(store.publicRoot).replace(/[^A-Za-z0-9._:@+-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const id = TOKEN.test(raw) ? raw : "repository";
  return { kind: "repository", id };
}
export function partitionOf(store: HunchStore): Scope {
  const declaration = partitionDeclarationOf(store);
  return { kind: declaration.kind, id: declaration.id };
}
/** @deprecated name kept for callers written before served partitions; same value as partitionOf. */
export const repositoryScope = partitionOf;

export const recordScope = (record: unknown, repo: Scope): Scope => {
  const parsed = ScopeSchema.safeParse((record as { scope?: unknown }).scope);
  return parsed.success ? parsed.data : repo;
};
