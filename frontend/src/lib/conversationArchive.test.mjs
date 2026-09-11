import assert from "node:assert/strict";
import test from "node:test";
import { createConversationArchiveScheduler } from "./conversationArchive.js";
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("metadata and message updates send one latest snapshot without reading superseded history", async () => {
  const enqueue = createConversationArchiveScheduler();
  const sent = [];
  let historyReads = 0;
  const metadata = enqueue("thread", () => { historyReads++; sent.push(["old"]); });
  const messages = enqueue("thread", () => { sent.push(["latest"]); });
  assert.equal(sent.length, 0);
  assert.deepEqual(await Promise.all([metadata, messages]), [true, true]);
  assert.equal(historyReads, 0);
  assert.deepEqual(sent, [["latest"]]);
});

test("slow archiving coalesces pending updates but deletion waits behind the final snapshot", async () => {
  const enqueue = createConversationArchiveScheduler();
  const sent = [];
  let finish;
  const first = enqueue("thread", () => { sent.push("first"); return new Promise((resolve) => { finish = resolve; }); });
  await tick();
  const older = enqueue("thread", () => { sent.push("older"); });
  const latest = enqueue("thread", () => { sent.push("latest"); });
  let deletionAcknowledged = false;
  const deletion = enqueue("thread", () => { sent.push("deleted"); }, { deleted: true }).then((saved) => { deletionAcknowledged = saved; });
  await tick();
  assert.deepEqual(sent, ["first"]);
  assert.equal(deletionAcknowledged, false);
  finish({});
  await Promise.all([first, older, latest, deletion]);
  assert.deepEqual(sent, ["first", "latest", "deleted"]);
  assert.equal(deletionAcknowledged, true);
});

test("archive failures report once per coalesced job and reject deletion acknowledgement", async () => {
  const errors = [];
  const enqueue = createConversationArchiveScheduler({ reportError: (error) => errors.push(error.message) });
  const first = enqueue("thread", () => {});
  const second = enqueue("thread", () => { throw new Error("Disk unavailable"); });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.deepEqual(errors, ["Disk unavailable"]);
  assert.equal(await enqueue("thread", () => Promise.reject(new Error("Deletion failed")), { deleted: true }), false);
  assert.equal(await enqueue("thread", () => ({ warnings: ["Attachment missing"] })), true);
  assert.deepEqual(errors, ["Disk unavailable", "Deletion failed", "Attachment missing"]);
});
