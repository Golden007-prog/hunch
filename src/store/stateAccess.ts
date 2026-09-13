/** A request-local access view. Never installs mutable filters on shared stores. */
import type { HunchStore } from './hunchStore.js';
import { STATE_FACETS, scopePath, type Principal, type Scope } from '../core/stateContract.js';
import { visibilityAllows } from '../core/recordVisibility.js';
import { recordScope, partitionOf, partitionDeclarationOf } from './statePartition.js';

export interface StateAccessOptions { additionalStores?: readonly HunchStore[]; requireVisibility?: boolean }
type RecordValue = Record<string, unknown>;

export function createStateAccess(store: HunchStore, principal: Principal, opts: StateAccessOptions = {}) {
  const repo = partitionOf(store), grants = new Set(principal.grants.map(scopePath));
  const sources = [...new Set([store, ...(opts.additionalStores ?? [])])].map(source => ({ source, scope: partitionDeclarationOf(source) }));
  // Protected writers persist this gate before the first restricted record and never remove it.
  const restricted = !!opts.requireVisibility || sources.some(source => !!source.scope.required_capabilities?.length);
  const recordScopes = new WeakMap<object, Scope>();
  const scoped = (record: unknown) => recordScopes.get(record as object) ?? recordScope(record, repo);
  const baseAllows = (record: unknown, mode: 'read' | 'write' = 'read') => grants.has(scopePath(scoped(record))) && visibilityAllows(record, principal.id, mode);
  const lookup = new Map<string, RecordValue[]>();
  function find(id: string): RecordValue[] {
    const cached = lookup.get(id); if (cached) return cached;
    const found: RecordValue[] = [];
    for (const { source, scope } of sources) for (const facet of STATE_FACETS) {
      let record: unknown;
      // Exact capture/replay must not enumerate a high-cardinality collection. Its
      // schemas require these prefixes; other strings cannot identify these records.
      if (facet === 'derived' || facet === 'receipts' || facet === 'commitments') {
        const prefix = { derived: 'nds', receipts: 'nrc', commitments: 'ncm' }[facet];
        if (!new RegExp(`^${prefix}_[a-f0-9]{24}$`).test(id)) continue;
        record = source.getStateDirect(facet, id, 'private') ?? source.getStateDirect(facet, id, 'public');
      } else record = source.getRec(facet, id);
      if (record) { const value = record as RecordValue; recordScopes.set(value, recordScope(value, scope)); found.push(value); }
    }
    lookup.set(id, found); return found;
  }
  // Walk only the reachable dependency graph, iteratively so cycles and deep chains
  // cannot overflow the stack. Complete records are withheld, never hash-preserving redactions.
  function referencesVisible(root: unknown): boolean {
    const queue: unknown[] = [root], visited = new Set<unknown>();
    for (let i = 0; i < queue.length; i++) {
      const record = queue[i]; if (!record || typeof record !== 'object' || visited.has(record)) continue;
      visited.add(record);
      if (i > 0 && (!visibilityAllows(record, principal.id) || (restricted && !baseAllows(record)))) return false;
      const own = scoped(record);
      const values: Array<{ value: unknown; field?: string }> = [{ value: record }];
      while (values.length) {
        const { value, field } = values.pop()!;
        if (field === 'visibility' || field === 'id') continue;
        if (typeof value === 'string') { queue.push(...find(value)); continue; }
        if (Array.isArray(value)) { for (const child of value) values.push({ value: child }); continue; }
        if (!value || typeof value !== 'object') continue;
        const ref = value as RecordValue;
        if (ref.kind === 'record' && typeof ref.id === 'string') {
          const scope = recordScope(ref, own), matches = find(ref.id).filter(candidate => scopePath(scoped(candidate)) === scopePath(scope));
          if (restricted && (!grants.has(scopePath(scope)) || !matches.length)) return false;
          queue.push(...matches); continue;
        }
        for (const [name, child] of Object.entries(ref)) values.push({ value: child, field: name });
      }
    }
    return true;
  }
  const canRead = (record: unknown) => !!record && baseAllows(record) && referencesVisible(record);
  return { restricted, canRead, referencesVisible, canWrite: (record: unknown) => canRead(record) && baseAllows(record, 'write') };
}
