const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createChromiumStderrFilter } = require("../chromium-stderr.cjs");

const prefix = "[552746:0910/164107.771391:ERROR:components/viz/service/display/display.cc:298] ";
const noise = `${prefix}Frame latency is negative: -0.011 ms\n`;

async function filter(chunks) {
  const stream = createChromiumStderrFilter();
  let output = "";
  stream.setEncoding("utf8");
  const done = (async () => { for await (const chunk of stream) output += chunk; })();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await done;
  return output;
}

test("native stderr filters only tiny negative frame timing samples across chunks", async () => {
  const other = `${prefix}GPU process crashed\n`;
  const large = `${prefix}Frame latency is negative: -1 ms\n`;
  const unrelated = "Application error: Frame latency is negative: -0.011 ms\n";
  assert.equal(await filter([other + noise.slice(0, 60), noise.slice(60) + large + unrelated]), other + large + unrelated);
  assert.equal(await filter([noise.trimEnd()]), "");
  assert.equal(await filter([noise.replace("\n", "\r\n")]), "");
});

test("native stderr preserves UTF-8, incomplete lines and long output", async () => {
  const bytes = Buffer.from("warning: café");
  assert.equal(await filter([bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1)]), "warning: café");
  const long = "x".repeat(70000);
  assert.equal(await filter([long, "tail\n"]), long + "tail\n");
});

test("console handler uses one event argument and records studio warnings/errors", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const start = source.indexOf('  app.on("web-contents-created",');
  const end = source.indexOf('  app.on("render-process-gone",', start);
  let register;
  const writes = [];
  const mainContents = {};
  const errorContents = {};
  vm.runInNewContext(source.slice(start, end), {
    app: { on: (_name, listener) => { register = listener; } },
    mainWindow: { webContents: mainContents },
    backendErrorWindow: { webContents: errorContents },
    applicationLog: { write: (...args) => writes.push(args) },
  });
  for (const contents of [mainContents, errorContents, {}]) {
    let handler;
    contents.on = (_name, listener) => { handler = listener; };
    register({}, contents);
    assert.equal(handler.length, 1, "Electron detects legacy listeners by argument count");
    for (const level of ["info", "warning", "error"]) handler({ level, message: level });
  }
  assert.deepEqual(writes, [
    ["warn", "renderer", "warning"], ["error", "renderer", "error"],
    ["warn", "renderer", "warning"], ["error", "renderer", "error"],
  ]);
});
