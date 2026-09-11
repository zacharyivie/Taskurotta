const { parentPort } = require("node:worker_threads");
const { archiveConversation } = require("./conversation-archive.cjs");
parentPort.on("message", ({ id, root, thread, messages, options }) => {
  try { parentPort.postMessage({ id, result: archiveConversation(root, thread, messages, options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
