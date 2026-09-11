// Component benchmark: real repository Git reads plus generated large log responses.
// CPU is this Node driver only, not Git children or a complete desktop session.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { startPolling, shareInFlight } from "../frontend/src/lib/refresh.js";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
let gitProcesses = 0;
const execFile = childProcess.execFile;
childProcess.execFile = function (...args) { gitProcesses += 1; return execFile(...args); };
const { readGitStatus } = require("../frontend/electron/git-status.cjs");
const root = path.resolve(process.argv[2] || fileURLToPath(new URL("..", import.meta.url)));
const phaseMs = Number(process.argv[3] || 10000);
if (!Number.isFinite(phaseMs) || phaseMs < 2500) throw new Error("Phase duration must be at least 2500 ms.");
const trackedFiles = childProcess.execFileSync("git", ["-C", root, "ls-files", "-z"]).toString().split("\0").filter(Boolean).length;
const payload = JSON.stringify(Array.from({ length: 10000 }, (_, index) => ({ index, output: "fixture ".repeat(64) })));
let requests = 0;
const server = http.createServer((_request, response) => {
  requests += 1;
  response.setHeader("Content-Type", "application/json");
  response.end(payload);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/log`;
const target = new EventTarget();
target.setTimeout = setTimeout;
target.clearTimeout = clearTimeout;
const documentTarget = new EventTarget();
const samples = [];
try {
  for (const hidden of [false, true]) {
    documentTarget.hidden = hidden;
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const before = { requests, gitProcesses };
    let polls = 0;
    const pending = new Set();
    const refresh = () => {
      polls += 1;
      const request = () => fetch(url).then((response) => response.json());
      const work = Promise.all([
        readGitStatus(root),
        shareInFlight("benchmark-log", request),
        shareInFlight("benchmark-log", request),
      ]);
      pending.add(work);
      return work.finally(() => pending.delete(work));
    };
    const stop = startPolling(refresh, { immediate: true, target, documentTarget });
    await new Promise((resolve) => setTimeout(resolve, phaseMs));
    stop();
    await Promise.all(pending);
    const used = process.cpuUsage(cpu);
    delay.disable();
    samples.push({ hidden, elapsedMs: performance.now() - started, polls,
      requests: requests - before.requests, gitProcesses: gitProcesses - before.gitProcesses,
      driverCpuMs: (used.user + used.system) / 1000, eventLoopP99Ms: delay.percentile(99) / 1e6,
      driverRssBytes: process.memoryUsage().rss });
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
const result = { workload: "Actual checkout Git status; generated 10,000-entry log; two concurrent log consumers",
  root, trackedFiles, logResponseBytes: Buffer.byteLength(payload), phaseMs, samples,
  limits: "Node component driver CPU/RSS, excluding Git child CPU. Not full-desktop idle CPU or RSS." };
const output = fileURLToPath(new URL("../audit-evidence/polling-benchmark.json", import.meta.url));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
