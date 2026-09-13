/** A request-local access view. Never installs mutable filters on shared stores. */
import type { HunchStore } from './hunchStore.js';
import { STATE_FACETS, scopePath, type Principal, type Scope } from '../core/stateContract.js';
import { visibilityAllows } from '../core/recordVisibility.js';
import { recordScope, partitionOf, partitionDeclarationOf } from './statePartition.js';

export interface StateAccessOptions { additionalStores?: readonly HunchStore[]; requireVisibility?: boolean }
type RecordValue = Record<string, unknown>;

export function createStateAccess(store: HunchStore, principal: Principal, opts: StateAccessOptions = {}) {
  const repo = partitionOf(store), grants = new Set(principal.grants.map(scopePath));
  const recordScopes = new WeakMap<object, Scope>();
  const scoped = (record: unknown) => recordScopes.get(record as object) ?? recordScope(record, repo);
  let declaredProtection = opts.requireVisibility ?? false;
  const indexed = new Map<string, RecordValue>(), byId = new Map<string, Set<string>>();
  const keyOf = (record: unknown, fallback = repo) => `${scopePath(recordScope(record, fallback))}\0${String((record as RecordValue).id)}`;
  for (const source of new Set([store, ...(opts.additionalStores ?? [])])) {
    const own = partitionDeclarationOf(source);
    declaredProtection ||= !!own.required_capabilities?.length;
    for (const facet of STATE_FACETS) for (const record of source.recs(facet)) {
      const key = keyOf(record, own), value = record as unknown as RecordValue;
      recordScopes.set(value, recordScope(record, own));
      indexed.set(key, value);
      const keys = byId.get(String(value.id)) ?? new Set<string>(); keys.add(key); byId.set(String(value.id), keys);
    }
  }
  const baseAllows = (record: unknown, mode: 'read' | 'write' = 'read') => grants.has(scopePath(scoped(record))) && visibilityAllows(record, principal.id, mode);
  const protectedRecords = declaredProtection || [...indexed.values()].some(r => r.visibility !== undefined);
  const blocked = new Set<string>(), dependents = new Map<string, Set<string>>();
  // Exact structured record references propagate restrictions. Free-form prose is
  // not a data-loss-prevention classifier; writers remain responsible for its audience.
  const references = (record: unknown): { keys: Set<string>; unavailable: boolean } => {
    const keys = new Set<string>(); let unavailable = false;
    const own = scoped(record);
    const walk = (value: unknown, field?: string): void => {
      if (field === 'visibility' || field === 'id') return;
      if (typeof value === 'string') { for (const key of byId.get(value) ?? []) keys.add(key); return; }
      if (Array.isArray(value)) { value.forEach(v => walk(v)); return; }
      if (!value || typeof value !== 'object') return;
      const ref = value as RecordValue;
      if (ref.kind === 'record' && typeof ref.id === 'string') {
        const scope = recordScope(ref, own), key = `${scopePath(scope)}\0${ref.id}`;
        if (protectedRecords && (!grants.has(scopePath(scope)) || !indexed.has(key))) unavailable = true;
        if (indexed.has(key)) keys.add(key);
        return;
      }
      for (const [name, child] of Object.entries(ref)) walk(child, name);
    };
    walk(record); return { keys, unavailable };
  };
  for (const [key, record] of indexed) {
    const refs = references(record);
    if (!visibilityAllows(record, principal.id) || (protectedRecords && !baseAllows(record)) || refs.unavailable) blocked.add(key);
    for (const ref of refs.keys) { const next = dependents.get(ref) ?? new Set<string>(); next.add(key); dependents.set(ref, next); }
  }
  // Fixed point, including cycles: a hidden source withholds every dependent,
  // preserving original records/hashes instead of redacting authenticated bytes.
  const queue = [...blocked];
  for (let i = 0; i < queue.length; i++) for (const key of dependents.get(queue[i]!) ?? []) if (!blocked.has(key)) { blocked.add(key); queue.push(key); }
  const referencesVisible = (record: unknown) => { const refs = references(record); return !refs.unavailable && [...refs.keys].every(key => !blocked.has(key)); };
  const canRead = (record: unknown) => !!record && baseAllows(record) && !blocked.has(`${scopePath(scoped(record))}\0${String((record as RecordValue).id)}`) && referencesVisible(record);
  return { restricted: protectedRecords, canRead, referencesVisible, canWrite: (record: unknown) => canRead(record) && baseAllows(record, 'write') };
}
