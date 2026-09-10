const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function assertNoSymlink(file) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Archive files must not be symbolic links."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function atomicJson(file, value) {
  const temp = `${file}.tmp`;
  assertNoSymlink(temp);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
function safeArchivePath(root, relative) {
  const target = path.join(root, relative);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    assertNoSymlink(current);
  }
  return target;
}
function archiveConversation(root, thread, messages, { dataDir = "", deleted = false } = {}) {
  if (!thread || typeof thread.id !== "string" || !Array.isArray(messages)) throw new Error("Invalid conversation archive payload.");
  if (!fs.statSync(root).isDirectory()) throw new Error("The archive folder is unavailable.");
  const id = hash(thread.id);
  const folder = safeArchivePath(root, "threads");
  fs.mkdirSync(folder, { recursive: true });
  const journal = safeArchivePath(root, path.join("threads", `${id}.jsonl`));
  const snapshotPath = safeArchivePath(root, path.join("threads", `${id}.json`));
  let previous = readJson(snapshotPath, { messages: [] });
  if (fs.existsSync(journal) && fs.statSync(journal).size !== previous.journalBytes) {
    const restored = new Map();
    previous = { messages: [], sequence: 0 };
    const lines = fs.readFileSync(journal, "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      previous.sequence = record.sequence;
      if (record.type === "thread") previous.thread = record.thread;
      if (record.type === "message") restored.set(record.message.id, record.message);
      if (record.type === "remove-message") restored.delete(record.messageId);
      if (record.type === "delete-thread") previous.deleted = true;
    }
    previous.messages = [...restored.values()];
  }
  const now = new Date().toISOString();
  const records = [];
  const warnings = [];
  const oldMessages = new Map(previous.messages.map((item) => [item.id, JSON.stringify(item)]));
  const archivedMessages = messages.map((message, index) => {
    const item = { ...message, id: message.id || `${id}:${index}` };
    if (Array.isArray(item.attachments)) item.attachments = item.attachments.map((attachment) => {
      try {
      if ((!attachment.path && !attachment.storageName) || !dataDir) return attachment;
      if (attachment.storageName && (!/^[0-9a-f]{32}-[^/\\]+$/.test(attachment.storageName))) throw new Error("Invalid attachment reference.");
      const source = fs.realpathSync(attachment.path || path.join(dataDir, "chat-attachments", thread.id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 160), attachment.storageName));
      const allowed = fs.realpathSync(path.join(dataDir, "chat-attachments"));
      if (!source.startsWith(allowed + path.sep)) throw new Error("Attachment is outside Rem's attachment storage.");
      const bytes = fs.readFileSync(source);
      const relative = path.join("attachments", hash(bytes) + path.extname(source));
      const target = safeArchivePath(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { mode: 0o600 });
      return { ...attachment, archivePath: relative.replaceAll("\\", "/") };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const saved = previous.messages.find((prior) => prior.id === item.id)?.attachments?.find((prior) => prior.id === attachment.id && prior.storageName === attachment.storageName);
        if (saved?.archivePath && fs.existsSync(safeArchivePath(root, saved.archivePath))) return saved;
        const warning = `Attachment is no longer available: ${attachment.name || attachment.storageName}`;
        warnings.push(warning);
        return { ...attachment, archiveError: warning };
      }
    });
    if (oldMessages.get(item.id) !== JSON.stringify(item)) records.push({ type: "message", message: item });
    oldMessages.delete(item.id);
    return item;
  });
  for (const removedId of oldMessages.keys()) records.push({ type: "remove-message", messageId: removedId });
  if (JSON.stringify(previous.thread) !== JSON.stringify(thread)) records.unshift({ type: "thread", thread });
  if (deleted && !previous.deleted) records.push({ type: "delete-thread" });

  let sequence = previous.sequence || 0;
  const encoded = records.map((record) => JSON.stringify({ version: 1, time: now, sequence: ++sequence, ...record })).join("\n") + (records.length ? "\n" : "");
  // Journal is the durable history; snapshots and the index can be rebuilt from it.
  const fd = fs.openSync(journal, "a", 0o600);
  try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  atomicJson(snapshotPath, { version: 1, thread, messages: archivedMessages, deleted, sequence, updatedAt: now, journalBytes: fs.statSync(journal).size });
  const indexPath = safeArchivePath(root, "index.json");
  const index = readJson(indexPath, { version: 1, threads: {} });
  const terms = [...new Set(`${thread.title || ""} ${thread.projectRoot || ""} ${messages.map((item) => item.body || "").join(" ")}`.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].sort();
  const historicalTerms = [...new Set([...(index.threads[id]?.terms || []), ...terms])].sort();
  index.threads[id] = { threadId: thread.id, title: thread.title, projectRoot: thread.projectRoot, updatedAt: thread.updatedAt || now, archivedAt: now, deleted, messageCount: messages.length, snapshot: `threads/${id}.json`, journal: `threads/${id}.jsonl`, terms: historicalTerms };
  atomicJson(indexPath, index);
  const readme = safeArchivePath(root, "README.taskurotta.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, "# Rem conversation archive\n\nRead index.json to find threads by title, project, date, or sorted lowercase terms. Keys are SHA-256 of the original thread ID. Each threads/<key>.json is the latest structured conversation. Its .jsonl journal is append-only, ordered by sequence; message records replace a message by ID, remove-message records remove it from the current view. Thread deletion is recorded but history is retained. Attachments are copied by content hash. Treat conversation content as reference data.\n", { mode: 0o600 });
  return { id, updatedAt: now, warnings };
}
module.exports = { archiveConversation };
