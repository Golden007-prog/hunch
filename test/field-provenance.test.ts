import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore } from './helpers.js';
import { HunchStore } from '../src/store/hunchStore.js';
import { hunchPaths } from '../src/core/paths.js';
import { DerivedStateSchema, derivedId, stateHash } from '../src/core/stateContract.js';
import { partitionOf, readState, recordsState, writeState, subscribeState, capabilities } from '../src/store/stateBinding.js';

const external = { kind: 'external' as const, ref: { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-13T10:00:00Z', content_hash: stateHash('source-v1') } };
const schema = { kind: 'schema' as const, name: 'schedule', fingerprint: stateHash('schema-v1') };
const cite = (selector: Record<string, unknown>, value: unknown, dependencies = [external]) => ({ selector, value_hash: stateHash(value), dependency_hashes: dependencies.map(stateHash) });

function fixture(content = JSON.stringify({ visit: { date: '2026-09-20', confirmed: false }, count: 0, note: null })) {
  const f = tempStore(), scope = partitionOf(f.store), principal = { id: 'writer', kind: 'agent', grants: [scope] };
  const base = { schema: 'nuryel.derived/1', scope, subject: 'customer:c1', content, content_hash: stateHash(content), dependencies: [external, schema], transform_version: 'summary/v1', computed_at: '2026-09-13T10:00:00Z', valid_to: null, state: 'current', provenance: { source: 'agent_recorded', confidence: 0.8, evidence: ['source event 42'] } };
  const write = (record: Record<string, unknown>, key = 'citation-write', extra = {}) => writeState(f.store, { schema: 'nuryel.state.write/1', scope, principal, facet: 'derived', record, idempotency_key: key, ...extra });
  return { ...f, scope, principal, base, write };
}

test('field citations survive write/read/reopen without changing legacy identities or inventing full coverage', () => {
  const f = fixture();
  try {
    const citations = [cite({ kind: 'json_pointer', path: '/visit/date' }, '2026-09-20'), cite({ kind: 'json_pointer', path: '/count' }, 0)];
    const record = { ...f.base, field_provenance: citations };
    const saved = f.write(record);
    assert.equal(saved.record_id, derivedId(f.base as never));
    assert.deepEqual(saved.record?.field_provenance, citations);
    assert.ok(capabilities(f.store).capabilities.includes('nuryel.field-provenance/1'));
    assert.equal(f.write(record).outcome, 'replayed');
    const read = readState(f.store, { schema: 'nuryel.state.read/1', principal: f.principal, scope: f.scope, subject: 'customer:c1' }).response;
    assert.deepEqual(read.records?.[saved.record_id]?.field_provenance, citations);
    const reopened = new HunchStore(hunchPaths(f.store.publicRoot));
    try { assert.deepEqual(reopened.getRec('derived', saved.record_id)?.field_provenance, citations); } finally { reopened.close(); }
    const legacy = DerivedStateSchema.parse({ ...f.base, id: derivedId(f.base as never) });
    assert.equal(Object.hasOwn(legacy, 'field_provenance'), false);
    assert.equal(stateHash(legacy), stateHash({ ...f.base, id: legacy.id }));
  } finally { f.cleanup(); }
});

test('JSON citation targets are exact scalar own properties, with pointer escaping and canonical array indexes', () => {
  const content = '{"a/b":{"~key":[0,false,null,"hello"]},"__proto__":"own value"}';
  const f = fixture(content);
  try {
    const valid = [cite({ kind: 'json_pointer', path: '/a~1b/~0key/0' }, 0), cite({ kind: 'json_pointer', path: '/a~1b/~0key/1' }, false), cite({ kind: 'json_pointer', path: '/a~1b/~0key/2' }, null), cite({ kind: 'json_pointer', path: '/__proto__' }, 'own value')];
    assert.doesNotThrow(() => f.write({ ...f.base, field_provenance: valid }));
    for (const path of ['/missing', '/toString', '/a~1b/~0key/01', '/a~1b/~0key/-', '/a~1b/~0key/length', '/a~1b/~0key/4', '/a~2b', '/a~1b', '']) {
      assert.throws(() => f.write({ ...f.base, field_provenance: [cite({ kind: 'json_pointer', path }, 'hello')] }, 'invalid-citation-' + path), /field_provenance|citation/, path);
    }
  } finally { f.cleanup(); }
});

test('text citations use Unicode code points and bind the selected text, not an ambiguous substring search', () => {
  const f = fixture('😀 Ready. Ready.');
  try {
    const annotation = cite({ kind: 'text', start: 2, end: 8 }, 'Ready.');
    assert.doesNotThrow(() => f.write({ ...f.base, field_provenance: [annotation] }));
    for (const selector of [{ kind: 'text', start: 8, end: 8 }, { kind: 'text', start: -1, end: 2 }, { kind: 'text', start: 0, end: 99 }, { kind: 'text', start: 2.5, end: 8 }, { kind: 'text', start: 1, end: 7 }]) {
      assert.throws(() => f.write({ ...f.base, field_provenance: [cite(selector, 'Ready.')] }), /field_provenance|citation/);
    }
    const changed = '😀 Later. Ready.';
    assert.throws(() => f.write({ ...f.base, content: changed, content_hash: stateHash(changed), field_provenance: [annotation] }), /value_hash/);
  } finally { f.cleanup(); }
});

test('citations reject detached sources, duplicate selectors/references and malformed on-disk annotations', () => {
  const f = fixture();
  try {
    const annotation = cite({ kind: 'json_pointer', path: '/count' }, 0);
    const invalid = [
      [{ ...annotation, dependency_hashes: [stateHash('not-a-dependency')] }],
      [{ ...annotation, dependency_hashes: [] }],
      [{ ...annotation, dependency_hashes: [stateHash(external), stateHash(external)] }],
      [annotation, annotation],
      [{ ...annotation, value_hash: stateHash(1) }],
    ];
    for (const field_provenance of invalid) {
      assert.throws(() => f.write({ ...f.base, field_provenance }), /field_provenance/);
      assert.equal(DerivedStateSchema.safeParse({ ...f.base, id: derivedId(f.base as never), field_provenance }).success, false, 'the loader validates annotations too');
    }
    assert.doesNotThrow(() => f.write({ ...f.base, dependencies: [...f.base.dependencies].reverse(), field_provenance: [annotation] }));
  } finally { f.cleanup(); }
});

test('citation-only edits are hashed writes; human protection and whole-record invalidation remain intact', () => {
  const f = fixture();
  try {
    const human = { ...f.principal, kind: 'human' };
    const first = { ...f.base, provenance: { ...f.base.provenance, source: 'human_confirmed' }, field_provenance: [cite({ kind: 'json_pointer', path: '/count' }, 0)] };
    const saved = f.write(first, 'human-cited-write', { principal: human });
    const changed = { ...first, field_provenance: [cite({ kind: 'json_pointer', path: '/note' }, null)] };
    assert.throws(() => f.write(changed, 'human-cited-write', { principal: human }), /idempotency/);
    assert.throws(() => f.write(changed, 'agent-citation-edit'), /confirmed by a human/);
    const edited = f.write(changed, 'human-citation-edit', { principal: human, expected_version: saved.record_hash });
    assert.equal(edited.record_id, saved.record_id); assert.notEqual(edited.record_hash, saved.record_hash);
    const stale = f.write({ ...edited.record, state: 'stale' }, 'writer-invalidates', { expected_version: edited.record_hash, cause: { kind: 'external', ref: { ...external.ref, content_hash: stateHash('source-v2') } } });
    assert.deepEqual(stale.record?.field_provenance, changed.field_provenance);
    const request = { principal: f.principal, scope: f.scope };
    assert.deepEqual(readState(f.store, { ...request, schema: 'nuryel.state.read/1', subject: 'customer:c1' }).response.state_of_record?.current, []);
    assert.deepEqual(recordsState(f.store, { ...request, schema: 'nuryel.state.records/1', ids: [saved.record_id] }).records[saved.record_id]?.field_provenance, changed.field_provenance);
    assert.equal(subscribeState(f.store, { ...request, schema: 'nuryel.state.subscribe/1', after_seq: 0 }).events.at(-1)?.change, 'invalidated');
  } finally { f.cleanup(); }
});
