import assert from "node:assert/strict";
import test from "node:test";
import { loadConversationMessages, saveConversationMessages, removeConversationMessages } from "./conversationStorage.js";

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    values, writes: [], fail: null,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (this.fail?.(key, value)) throw new DOMException("Storage unavailable", "QuotaExceededError");
      this.writes.push([key, value]);
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); },
  };
}
const message = (id, body = `Message ${id}`) => ({ id, role: "assistant", body });
const key = "gofer-flow-chat-thread:test";
const reopen = (storage) => memoryStorage(storage.values);

test("existing array history preserves attachments, ordering, edit metadata, and exact storage format", () => {
  const messages = [message("a"), { ...message("b"), attachments: [{ dataUrl: "data:text/plain;base64,YQ==" }], changes: { undone: true } }];
  const encoded = JSON.stringify(messages);
  const storage = memoryStorage([[key, encoded]]);
  const restored = loadConversationMessages(key, storage);
  assert.deepEqual(restored, messages);
  saveConversationMessages(key, restored, storage);
  assert.equal(storage.getItem(key), encoded);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), messages);
});

test("long history updates serialize only changed messages while keeping one atomic array write", () => {
  let serialized = 0;
  const history = Array.from({ length: 1000 }, (_, id) => ({
    ...message(String(id), "x".repeat(4096)),
    toJSON() { serialized += 1; return { id: this.id, role: this.role, body: this.body }; },
  }));
  const storage = memoryStorage();
  saveConversationMessages(key, history, storage);
  assert.equal(serialized, 1000);
  serialized = 0;
  storage.writes.length = 0;
  const next = [...history.slice(0, -1), message("999", "next")];
  saveConversationMessages(key, next, storage);
  assert.equal(serialized, 0);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.length, 1);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)).at(-1), next.at(-1));
});

test("edit, truncate, reorder, and deletion preserve other histories and older React snapshots", () => {
  const storage = memoryStorage();
  const history = [message("a"), message("b"), message("c")];
  saveConversationMessages(key, history, storage);
  saveConversationMessages("other", [message("other")], storage);
  const changed = [history[2], { ...history[0], body: "edited" }];
  saveConversationMessages(key, changed, storage);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), changed);
  saveConversationMessages(key, history, storage);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), history);
  removeConversationMessages(key, storage);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), []);
  assert.deepEqual(loadConversationMessages("other", reopen(storage)), [message("other")]);
  assert.equal(storage.length, 1);
});

test("failed writes preserve the last complete history and subsequent retries persist all changes", () => {
  const storage = memoryStorage();
  const before = [message("a"), message("b")];
  const after = [message("c"), message("d")];
  saveConversationMessages(key, before, storage);
  storage.fail = () => true;
  assert.throws(() => saveConversationMessages(key, after, storage), { name: "QuotaExceededError" });
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), before);
  storage.fail = null;
  saveConversationMessages(key, after, storage);
  assert.deepEqual(loadConversationMessages(key, reopen(storage)), after);
});

test("single and multi-message replacements, appends, and truncation retain original quota capacity", () => {
  const storage = memoryStorage();
  storage.fail = (target, value) => [...storage.values].reduce((sum, [key, previous]) => sum + (key === target ? 0 : previous.length), value.length) > 2600;
  for (const messages of [
    [message("a", "x".repeat(1000))],
    [message("a", "y".repeat(1800))],
    [message("a", "x".repeat(1000)), message("b", "x".repeat(1000))],
    [message("a", "y".repeat(1200)), message("b", "z".repeat(1200))],
    [message("a", "z".repeat(1800))],
    [message("a", "z".repeat(1800)), message("b", "x".repeat(500))],
  ]) {
    const originalEncoding = JSON.stringify(messages);
    assert.ok(originalEncoding.length < 2600);
    saveConversationMessages(key, messages, storage);
    assert.equal(storage.getItem(key), originalEncoding);
    assert.deepEqual(loadConversationMessages(key, reopen(storage)), messages);
  }
  const committed = storage.getItem(key);
  assert.throws(() => saveConversationMessages(key, [message("oversized", "x".repeat(3000))], storage), { name: "QuotaExceededError" });
  assert.equal(storage.getItem(key), committed);
});

test("malformed stored history retains original empty recovery behavior", () => {
  for (const raw of ["invalid json", "null", "{}", '[{"role":"user"}]', '[{"role":"user","body":"valid"},null]']) {
    const storage = memoryStorage([[key, raw]]);
    assert.deepEqual(loadConversationMessages(key, storage), []);
    saveConversationMessages(key, [message("recovered")], storage);
    assert.deepEqual(loadConversationMessages(key, reopen(storage)), [message("recovered")]);
  }
});
