import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { runMediaProcess } from "../src/media/process.mjs";

test("propagates a queue checkpoint into a running provider subprocess", async () => {
  const controller = new globalThis.AbortController();
  const checkpoint = new Error("04:00 checkpoint");
  checkpoint.code = "MEDIA_CHECKPOINT";
  const running = runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    timeoutMs: 10_000,
    label: "fixture provider",
    signalProcessGroup,
  });
  await setTimeout(25);
  controller.abort(checkpoint);

  await assert.rejects(running, (error) => error === checkpoint);
});

test("does not start a provider subprocess after its checkpoint signal already fired", async () => {
  const controller = new globalThis.AbortController();
  const checkpoint = new Error("04:00 checkpoint");
  checkpoint.code = "MEDIA_CHECKPOINT";
  controller.abort(checkpoint);

  await assert.rejects(
    runMediaProcess("command-that-must-not-start", [], {
      signal: controller.signal,
      timeoutMs: 10_000,
      label: "fixture provider",
      signalProcessGroup,
    }),
    (error) => error === checkpoint,
  );
});

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function run(script, options = {}) {
  return runMediaProcess(process.execPath, ["-e", script], {
    label: "fixture provider",
    timeoutMs: 100,
    graceMs: 50,
    cleanupMs: 300,
    signalProcessGroup,
    ...options,
  });
}

test("normal outputs are complete and failures disclose no private output", async () => {
  assert.deepEqual(await run("console.log('ok');console.error('warning')", { timeoutMs: 1000 }), {
    stdout: "ok\n",
    stderr: "warning\n",
  });
  await assert.rejects(
    run("console.error('private fixture');process.exit(2)", { timeoutMs: 1000 }),
    (error) => /exit 2/.test(error.message) && !error.message.includes("private fixture"),
  );
  await assert.rejects(
    runMediaProcess("missing-fixture-executable", [], {
      label: "fixture",
      timeoutMs: 100,
      signalProcessGroup,
    }),
    /could not start.*Check/,
  );
});

test("forces a TERM-ignoring child within the cleanup bound and permits recovery", async () => {
  const start = Date.now();
  await assert.rejects(
    run("process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500)"),
    /timed out/,
  );
  assert.ok(Date.now() - start < 800);
  assert.equal((await run("console.log('recovered')", { timeoutMs: 1000 })).stdout, "recovered\n");
});

test("checkpoint survives forced group cleanup including inherited pipes", async () => {
  const controller = new globalThis.AbortController();
  const reason = new Error("checkpoint fixture");
  reason.code = "MEDIA_CHECKPOINT";
  const script = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500)"],{stdio:['ignore',1,2]});
    process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500);`;
  const start = Date.now();
  const running = run(script, { timeoutMs: 2000, signal: controller.signal });
  await setTimeout(100);
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  assert.ok(Date.now() - start < 800);
});

for (const stream of ["stdout", "stderr"]) {
  test(`${stream} overflow fails without returning truncated protocol data`, async () => {
    await assert.rejects(
      run(`process.${stream}.write('private fixture'.repeat(1000));setTimeout(()=>{},1500)`, {
        stdoutMaxBytes: 64,
        stderrMaxBytes: 64,
      }),
      (error) =>
        error.code === "MEDIA_OUTPUT_LIMIT" &&
        /limit.*Check/.test(error.message) &&
        !error.message.includes("private fixture"),
    );
  });
}

test("unconfirmed cleanup overrides a checkpoint with global safety", async () => {
  const controller = new globalThis.AbortController();
  const reason = new Error("checkpoint fixture");
  reason.code = "MEDIA_CHECKPOINT";
  const running = run("setTimeout(()=>process.exit(),150)", {
    signal: controller.signal,
    cleanupMs: 100,
    signalProcessGroup(pid, signal) {
      if (signal === 0) return true;
      return signalProcessGroup(pid, signal);
    },
  });
  await setTimeout(30);
  controller.abort(reason);
  await assert.rejects(
    running,
    (error) => error.globalSafety === true && error.code === "MEDIA_PROCESS_CLEANUP",
  );
});

test("owned group signals never target an unrelated process", async () => {
  const { spawn } = await import("node:child_process");
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(),1500)"], {
    stdio: "ignore",
  });
  const signals = [];
  try {
    await assert.rejects(
      run("process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500)", {
        signalProcessGroup(pid, signal) {
          assert.notEqual(pid, unrelated.pid);
          signals.push({ pid, signal });
          return signalProcessGroup(pid, signal);
        },
      }),
      /timed out/,
    );
    assert.equal(new Set(signals.map(({ pid }) => pid)).size, 1);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  } finally {
    unrelated.kill("SIGKILL");
    await new Promise((resolve) => unrelated.once("close", resolve));
  }
});

test("invalid bounds or missing group ownership never start a process", async () => {
  for (const options of [
    { stdoutMaxBytes: 0 },
    { stderrMaxBytes: Infinity },
    { signalProcessGroup: null },
  ]) {
    await assert.rejects(
      run("throw new Error('must not start')", options),
      /Check the media runtime composition/,
    );
  }
});

test("transient cleanup probe denial never becomes false evidence of cleanup", async () => {
  let forced = false;
  let denied = false;
  await assert.rejects(
    run("process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500)", {
      signalProcessGroup(pid, signal) {
        // Simulate ignored TERM at the signalling boundary, independently of child startup.
        if (signal === "SIGTERM") return true;
        if (signal === "SIGKILL") forced = true;
        if (forced && signal === 0 && !denied) {
          denied = true;
          const error = new Error("fixture probe denial");
          error.code = "EPERM";
          throw error;
        }
        return signalProcessGroup(pid, signal);
      },
    }),
    /timed out/,
  );
  assert.equal(forced, true);
  assert.equal(denied, true);
});

test("a separately detached descendant is outside original-group cleanup evidence", async () => {
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(),1800)'],{detached:true,stdio:'ignore'});
    child.unref();console.log(child.pid);`;
  const groups = [];
  let escapedPid;
  try {
    const result = await run(script, {
      timeoutMs: 1000,
      signalProcessGroup(pid, signal) {
        groups.push(pid);
        return signalProcessGroup(pid, signal);
      },
    });
    escapedPid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 0);
    assert.equal(process.kill(escapedPid, 0), true);
    assert.ok(groups.length > 0);
    assert.ok(groups.every((pid) => pid !== escapedPid));
  } finally {
    if (escapedPid) stopFixtureProcess(escapedPid);
  }
});

function stopFixtureProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
