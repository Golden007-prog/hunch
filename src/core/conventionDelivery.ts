/** Explicit conventions alongside repository DNA. No scope wins and no policy is activated. */
import type { Convention, Scope } from './stateRecords.js';
import { scopePath, stateHash, type ConventionDelivery } from './stateContract.js';
import type { DeliverySupplement } from './delivery.js';
import { compareCodeUnits } from './canonicalOrder.js';

export function conventionCurrentness(record: Convention, resolve?: (id: string, scope: Scope) => unknown, now = Date.now()): 'recorded' | 'stale' {
  if (record.status === 'stale' || record.status === 'withdrawn' || record.valid_to !== null || Date.parse(record.valid_from) > now || Date.parse(record.review_by) <= now) return 'stale';
  for (const source of record.sources) if (source.kind === 'record') {
    const held = resolve?.(source.id, source.scope ?? record.scope) as Record<string, unknown> | undefined;
    if (!held || stateHash(held) !== source.record_hash || held.valid_to != null || held.state === 'stale' || held.status === 'stale' || held.status === 'withdrawn') return 'stale';
  }
  return 'recorded';
}

export function conventionDelivery(records: readonly Convention[], resolve?: (id: string, scope: Scope) => unknown, verified?: ReadonlyMap<string, "recorded" | "stale">): ConventionDelivery | undefined {
  const currentness = (record: Convention) => verified?.get(record.id) ?? conventionCurrentness(record, resolve);
  const candidates = [...new Map(records.map(r => [r.id, r])).values()].filter(r => r.valid_to === null && r.status !== 'withdrawn').sort((a, b) => compareCodeUnits(a.key, b.key) || compareCodeUnits(scopePath(a.scope), scopePath(b.scope)) || compareCodeUnits(a.id, b.id));
  if (!candidates.length) return undefined;
  const values = new Map<string, Set<string>>();
  for (const record of candidates) if (currentness(record) !== 'stale') {
    const set = values.get(record.key) ?? new Set<string>(); set.add(record.value); values.set(record.key, set);
  }
  let bytes = 0;
  const selected: Convention[] = [];
  for (const record of candidates) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (selected.length >= 16 || bytes + size > 16_384) break;
    selected.push(record); bytes += size;
  }
  return { advisory: true, items: selected.map(record => ({ ref: { facet: 'conventions', id: record.id, record_hash: stateHash(record), scope: record.scope }, key: record.key,
    currentness: currentness(record), conflict: (values.get(record.key)?.size ?? 0) > 1 })), truncated: selected.length < candidates.length };
}

/** The regular brief uses its existing token budget and keeps Project DNA's separate identity. */
export function conventionSupplements(records: readonly Convention[], resolve?: (id: string, scope: Scope) => unknown): DeliverySupplement[] {
  const delivery = conventionDelivery(records, resolve);
  if (!delivery) return [];
  const byId = new Map(records.map(r => [r.id, r]));
  return [{ id: 'explicit-conventions', kind: 'conventions', priority: 424,
    text: `EXPLICIT CONVENTIONS — advisory; scope is context, never precedence or policy authority. Resolve conflicting values before acting.${delivery.truncated || delivery.items.length > 8 ? ' Delivery is incomplete; more records exist.' : ''}` },
    ...delivery.items.slice(0, 8).map((item, i) => {
      const record = byId.get(item.ref.id)!;
      return { id: record.id, kind: 'convention', priority: 423 - i,
        text: `${scopePath(record.scope)} · ${record.key} · ${record.status}/${item.currentness}${item.conflict ? ' · CONFLICT' : ''}: ${record.value.slice(0, 300)} (revision ${item.ref.record_hash}; sources ${record.sources.length}; review by ${record.review_by})` };
    })];
}
