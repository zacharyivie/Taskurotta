import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEditorLifetimes, closeEditorLifetimes, acceptsEditorState, retainOpenEditorStates } from './editorStateLifetime.js';

test('closed editors release text and reject callbacks across close and reopen', () => {
  const lifetimes = new Map();
  reconcileEditorLifetimes(lifetimes, ['/large', '/dirty']);
  const old = lifetimes.get('/large');
  const states = { '/large': { content: 'x'.repeat(1000000) }, '/dirty': { dirty: true, content: 'unsaved' } };
  closeEditorLifetimes(lifetimes, ['/large']);
  assert.equal(acceptsEditorState(lifetimes, '/large', old), false);
  reconcileEditorLifetimes(lifetimes, ['/large', '/dirty']);
  assert.equal(acceptsEditorState(lifetimes, '/large', old), false);
  const retained = retainOpenEditorStates(states, ['/dirty']);
  assert.deepEqual(Object.keys(retained), ['/dirty']);
  assert.equal(retained['/dirty'], states['/dirty']);
  reconcileEditorLifetimes(lifetimes, ['/dirty']);
  reconcileEditorLifetimes(lifetimes, ['/large', '/dirty']);
  assert.equal(acceptsEditorState(lifetimes, '/large', old), false);
  assert.equal(acceptsEditorState(lifetimes, '/large', lifetimes.get('/large')), true);
});

test('open editors retain their state until a close succeeds', () => {
  const lifetimes = new Map();
  reconcileEditorLifetimes(lifetimes, ['/dirty']);
  const token = lifetimes.get('/dirty');
  const states = { '/dirty': { dirty: true, content: 'unsaved' } };
  assert.equal(retainOpenEditorStates(states, ['/dirty']), states);
  assert.equal(acceptsEditorState(lifetimes, '/dirty', token), true);
});
