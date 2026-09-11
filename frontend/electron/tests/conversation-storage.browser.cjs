const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-dev-shm-usage");
// This isolated regression process has the same display-container requirement
// as studio-policy.browser.cjs; production sandbox settings are unchanged.
app.commandLine.appendSwitch("no-sandbox");
let server;
const timeout = setTimeout(() => finish(new Error("Conversation storage browser test timed out")), 30000);
function finish(error) {
  clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  server?.close();
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/conversationStorage.js"));
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/storage.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/storage.js" ? source : "<!doctype html><title>Conversation storage regression</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const studio = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "conversation-storage-regression" } });
  await studio.loadURL(url);
  const timing = await studio.webContents.executeJavaScript(`(async () => {
    const { loadConversationMessages, saveConversationMessages } = await import('/storage.js');
    const key = 'test-conversation';
    const history = Array.from({length: 1000}, (_, id) => ({id: String(id), role: 'assistant', body: 'x'.repeat(2048)}));
    localStorage.setItem(key, JSON.stringify(history));
    const recovered = loadConversationMessages(key);
    saveConversationMessages(key, recovered);
    const metrics = {};
    for (const incremental of [false, true]) {
      let bytesWritten = 0;
      let maxTurnMs = 0;
      let messages = recovered;
      const measuredStorage = {
        getItem: key => localStorage.getItem(key),
        setItem: (key, value) => { bytesWritten += value.length; localStorage.setItem(key, value); },
        removeItem: key => localStorage.removeItem(key),
      };
      // Prime object identities outside the timed update loop.
      if (incremental) saveConversationMessages(key, messages, measuredStorage);
      bytesWritten = 0;
      const start = performance.now();
      for (let index = 0; index < 40; index++) {
        const turnStart = performance.now();
        messages = [...messages.slice(0, -1), {...messages.at(-1), body: 'Final update ' + index}];
        if (incremental) saveConversationMessages(key, messages, measuredStorage);
        else measuredStorage.setItem('baseline', JSON.stringify(messages));
        maxTurnMs = Math.max(maxTurnMs, performance.now() - turnStart);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      metrics[incremental ? 'cachedMessageSerialization' : 'fullArray'] = {elapsedMs: performance.now() - start, maxTurnMs, bytesWritten};
      localStorage.removeItem('baseline');
    }
    return metrics;
  })()`);
  // Navigation discards the module's identity cache, exercising disk recovery.
  await studio.loadURL(`${url}/reopened`);
  assert.deepEqual(await studio.webContents.executeJavaScript(`(async () => {
    const { loadConversationMessages, removeConversationMessages } = await import('/storage.js');
    const messages = loadConversationMessages('test-conversation');
    const result = {count: messages.length, final: messages.at(-1)?.body};
    removeConversationMessages('test-conversation');
    result.remainingKeys = localStorage.length;
    return result;
  })()`), { count: 1000, final: "Final update 39", remainingKeys: 0 });
  console.log("Real Chromium localStorage compatibility, reload, and deletion checks passed.");
  console.log(JSON.stringify({fixture: {messages: 1000, bodyBytes: 2048, updates: 40}, timing, caveat: "Generated fixture; elapsed time includes browser timer yielding; maxTurnMs measures synchronous save cost on this host. Full array joining and write volume are retained to preserve atomicity and quota capacity."}, null, 2));
  finish();
}).catch(finish);
