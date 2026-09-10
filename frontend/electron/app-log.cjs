const fs = require("node:fs");
const path = require("node:path");

function redactLog(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(bearer\s+)[\w.\-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|apiToken|access[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .slice(0, 32768);
}

function createAppLog(directory, { maxBytes = 5 * 1024 * 1024, backups = 3 } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "app.jsonl");
  return {
    file,
    write(level, source, message) {
      try {
        const line = JSON.stringify({ time: new Date().toISOString(), level, source, message: redactLog(message) }) + "\n";
        if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
          for (let i = backups; i >= 1; i -= 1) {
            const from = i === 1 ? file : `${file}.${i - 1}`;
            const to = `${file}.${i}`;
            if (fs.existsSync(to)) fs.unlinkSync(to);
            if (fs.existsSync(from)) fs.renameSync(from, to);
          }
        }
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch (error) {
        process.stderr.write(`Taskurotta could not persist its app log: ${error.code || "write failed"}\n`);
      }
    },
  };
}
module.exports = { createAppLog, redactLog };
