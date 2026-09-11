const { Transform } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

// Chromium 146 display.cc OnSwap discards a negative timing sample; it does
// not discard the frame. Hide only sub-millisecond noise from that diagnostic.
// Keep larger anomalies and all other errors visible. Native Chromium writes
// bypass console-message and process.stderr.write in the Electron process.
function createChromiumStderrFilter() {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const diagnostic = /^\[\d+:\d+\/\d+\.\d+:ERROR:components\/viz\/service\/display\/display\.cc:\d+\] Frame latency is negative: (-\d+(?:\.\d+)?) ms\r?\n?$/;
  function emit(stream, line) {
    const match = diagnostic.exec(line);
    if (!match || Number(match[1]) <= -1 || Number(match[1]) >= 0) stream.push(line);
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        emit(this, pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
      // Do not retain unbounded output from a process that never writes a newline.
      if (pending.length > 65536) {
        this.push(pending);
        pending = "";
      }
      callback();
    },
    flush(callback) {
      emit(this, pending + decoder.end());
      callback();
    },
  });
}

module.exports = { createChromiumStderrFilter };
