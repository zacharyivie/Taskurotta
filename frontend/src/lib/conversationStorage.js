// Chat messages are immutable React state objects. Cache each message's JSON so
// appends and edits do not repeatedly traverse/escape unchanged conversation
// bodies and attachments. Keep the existing single-key array representation:
// one setItem atomically replaces the history and preserves quota/recovery
// behavior, including multi-message edits near the storage limit. Joining and
// writing the complete string still allocates in proportion to history size.
const serializedMessages = new WeakMap();

export function loadConversationMessages(key, storage = globalThis.window?.localStorage) {
  try {
    const messages = JSON.parse(storage.getItem(key) || "null");
    return Array.isArray(messages)
      && messages.every((message) => message?.role && typeof message.body === "string")
      ? messages : [];
  } catch { return []; }
}

export function saveConversationMessages(key, messages, storage = globalThis.window?.localStorage) {
  const fragments = Array.from(messages, (message) => {
    if (message && typeof message === "object") {
      let encoded = serializedMessages.get(message);
      if (encoded === undefined) {
        encoded = JSON.stringify(message) ?? "null";
        serializedMessages.set(message, encoded);
      }
      return encoded;
    }
    return JSON.stringify(message) ?? "null";
  });
  storage.setItem(key, `[${fragments.join(",")}]`);
}

export function removeConversationMessages(key, storage = globalThis.window?.localStorage) {
  storage.removeItem(key);
}
