import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeCommandRunner } from "../src/media/runtime-command.mjs";

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

const child = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),2000)";
test("bounds direct API leaders and reports the narrower cleanup guarantee", async () => {
  const runner = createRuntimeCommandRunner({ commandTimeoutMs: 100 });
  await assert.rejects(
    runner(process.execPath, ["-e", child]),
    /direct API calls do not confirm descendant cleanup/,
  );
  assert.deepEqual(await runner(process.execPath, ["-e", ""], { timeoutMs: 1000 }), { code: 0 });
});

test("owned-group verification bounds hung tools, inherited children and output, then recovers", async () => {
  const runner = createRuntimeCommandRunner({
    signalProcessGroup,
    commandTimeoutMs: 200,
    graceMs: 30,
    cleanupMs: 500,
  });
  const inherited = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',1,2]});${child}`;
  for (const script of [child, inherited]) {
    await assert.rejects(
      runner(process.execPath, ["-e", script]),
      /timed out|cleanup could not be confirmed/,
    );
  }
  await assert.rejects(
    runner(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)"],
      { timeoutMs: 1000 },
    ),
    { code: "MEDIA_OUTPUT_LIMIT" },
  );
  assert.deepEqual(await runner(process.execPath, ["-e", ""], { timeoutMs: 1000 }), { code: 0 });
});

test("never converts uncertain owned-group cleanup to a verifier exit code", async () => {
  const runner = createRuntimeCommandRunner({
    commandTimeoutMs: 10,
    signalProcessGroup: () => {
      throw new Error("fixture signaling denied");
    },
  });
  await assert.rejects(runner(process.execPath, ["-e", "setTimeout(()=>{},100)"]), {
    code: "MEDIA_PROCESS_CLEANUP",
    globalSafety: true,
  });
});
