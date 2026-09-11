import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationCache } from './conversationCache.js';

function fixture(options = {}) {
  const stored = new Map();
  const writes = [];
  let snapshot = {};
  let reads = 0;
  const cache = createConversationCache({
    load(id) { reads++; return stored.get(id) || [{ role: 'user', body: id.repeat(100) }]; },
    save(id, messages) { writes.push(id); stored.set(id, messages); },
    changed(value) { snapshot = value; },
    ...options,
  });
  return { cache, stored, writes, get snapshot() { return snapshot; }, get reads() { return reads; } };
}

test('visiting 50 histories keeps active plus four recent histories and reloads evicted data once', () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) { f.cache.get(String(i)); f.cache.activate([String(i)]); }
  assert.equal(Object.keys(f.snapshot).length, 5);
  assert.equal(f.reads, 50);
  f.cache.get('0');
  f.cache.activate(['0']);
  f.cache.get('0');
  assert.equal(f.reads, 51);
  assert.equal(Object.keys(f.snapshot).length, 5);
});

test('byte budget evicts large inactive histories while running histories remain available', () => {
  const f = fixture({ maxBytes: 1000 });
  f.cache.get('running');
  f.cache.activate(['running', 'active']);
  f.cache.get('large-history');
  f.cache.get('active');
  f.cache.activate(['running', 'active']);
  assert.deepEqual(Object.keys(f.snapshot).sort(), ['active', 'running']);
});

test('100 events in one reader chunk persist once with all events in order', () => {
  const f = fixture();
  f.cache.activate(['stream']);
  f.cache.batch(() => {
    for (let i = 0; i < 100; i++) f.cache.update('stream', (history) => [...history, { role: 'assistant', body: String(i) }]);
  });
  assert.deepEqual(f.writes, ['stream']);
  assert.equal(f.stored.get('stream').length, 101);
  assert.equal(f.stored.get('stream').at(-1).body, '99');
});

test('error event still flushes earlier messages before leaving the reader chunk', () => {
  const f = fixture();
  assert.throws(() => f.cache.batch(() => {
    f.cache.update('stream', [{ role: 'assistant', body: 'before error' }]);
    throw new Error('provider failed');
  }), /provider failed/);
  assert.equal(f.stored.get('stream')[0].body, 'before error');
});

test('quota failure pins unsaved histories and later successful writes allow eviction', () => {
  let failed = true;
  const f = fixture({ maxInactive: 0, save: () => !failed });
  f.cache.update('failed', [{ role: 'assistant', body: 'unsaved' }]);
  f.cache.activate([]);
  assert.equal(f.snapshot.failed[0].body, 'unsaved');
  failed = false;
  f.cache.update('failed', (history) => history);
  assert.deepEqual(f.snapshot, {});
});

test('deletion discards pending writes without resurrecting the thread', () => {
  const f = fixture();
  f.cache.batch(() => { f.cache.update('deleted', []); f.cache.remove('deleted'); });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.snapshot, {});
});
