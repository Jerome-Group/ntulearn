import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { writeLine } from "../src/output.mjs";

const run = promisify(execFile);
const OUTPUT_MODULE = new URL("../src/output.mjs", import.meta.url).href;
const PAYLOAD_BYTES = 4_000_000;

// The regression this holds: `console.log` queues, so a `process.exit` after one drops whatever
// is still in the pipe's buffer. Only a payload well past that buffer can tell the two apart, so
// the check has to be a real child process with a real pipe rather than a stubbed stream.
function writeThenExitImmediately() {
  return `
    import { stdout } from "node:process";
    import { writeLine } from ${JSON.stringify(OUTPUT_MODULE)};
    await writeLine(stdout, "x".repeat(${PAYLOAD_BYTES}));
    process.exit(0);
  `;
}

test("a line is fully flushed before an immediate exit", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--input-type=module", "-e", writeThenExitImmediately()],
    {
      maxBuffer: PAYLOAD_BYTES * 2,
    },
  );
  assert.equal(stdout.length, PAYLOAD_BYTES + 1);
  assert.equal(stdout.at(-1), "\n");
});

test("a write to a closed stream rejects rather than resolving", async () => {
  const closed = { write: (_line, callback) => callback(new Error("EPIPE")) };
  await assert.rejects(writeLine(closed, "text"), /EPIPE/);
});
