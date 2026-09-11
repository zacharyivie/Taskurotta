// Only persisted inactive histories may be evicted. Active/running histories and
// failed writes remain available even when they exceed the inactive budget.
export function createConversationCache({ load, save, changed, maxInactive = 4, maxBytes = 8 * 1024 * 1024 }) {
  const entries = new Map();
  const sizes = new WeakMap();
  let protectedIds = new Set();
  let batchDepth = 0;
  const pending = new Set();
  function bytes(value) {
    if (typeof value === "string") return value.length * 2;
    if (!value || typeof value !== "object") return 8;
    if (!sizes.has(value)) sizes.set(value, Object.entries(value).reduce((sum, [key, child]) => sum + key.length * 2 + bytes(child), 32));
    return sizes.get(value);
  }
  function prune() {
    let count = 0;
    let retained = 0;
    for (const [id, entry] of [...entries].reverse()) {
      if (protectedIds.has(id) || entry.dirty) continue;
      count += 1;
      retained += bytes(entry.messages);
      if (count > maxInactive || retained > maxBytes) entries.delete(id);
    }
  }
  function publish() {
    prune();
    changed(Object.fromEntries([...entries].map(([id, entry]) => [id, entry.messages])));
  }
  function get(id) {
    let entry = entries.get(id);
    if (!entry) entry = { messages: load(id), dirty: false };
    entries.delete(id);
    entries.set(id, entry);
    return entry.messages;
  }
  function flush() {
    for (const id of pending) {
      const entry = entries.get(id);
      if (entry) entry.dirty = save(id, entry.messages) === false;
    }
    pending.clear();
    publish();
  }
  return {
    get,
    activate(ids) { protectedIds = new Set(ids); publish(); },
    update(id, next) {
      const current = get(id);
      entries.set(id, { messages: typeof next === "function" ? next(current) : next, dirty: true });
      pending.add(id);
      if (!batchDepth) flush();
    },
    // No timer: every complete reader chunk is durable before awaiting another
    // read, including when an error event interrupts processing the chunk.
    batch(callback) {
      batchDepth += 1;
      try { return callback(); } finally { if (!--batchDepth) flush(); }
    },
    remove(id) { pending.delete(id); entries.delete(id); publish(); },
  };
}
