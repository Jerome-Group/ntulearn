import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

for (const reason of [0, false, "", null]) {
  test(`preserves aborted reason ${JSON.stringify(reason)} before spawning`, async () => {
    const controller = new globalThis.AbortController();
    controller.abort(reason);
    await assert.rejects(
      runMediaProcess("command-that-must-not-start", [], {
        signal: controller.signal,
        timeoutMs: 1000,
        label: "fixture provider",
        signalProcessGroup,
      }),
      (error) => {
        assert.equal(error, reason);
        return true;
      },
    );
  });

  test(`preserves aborted reason ${JSON.stringify(reason)} after spawning`, async () => {
    const controller = new globalThis.AbortController();
    const running = run("setTimeout(()=>process.exit(),150)", {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort(reason);
    await assert.rejects(running, (error) => {
      assert.equal(error, reason);
      return true;
    });
  });

  test(`unsafe cleanup retains aborted reason ${JSON.stringify(reason)}`, async () => {
    const controller = new globalThis.AbortController();
    const running = run("setTimeout(()=>process.exit(),150)", {
      signal: controller.signal,
      timeoutMs: 1000,
      cleanupMs: 50,
      signalProcessGroup(pid, signal) {
        if (signal === 0) return true;
        return signalProcessGroup(pid, signal);
      },
    });
    controller.abort(reason);
    await assert.rejects(running, (error) => {
      assert.equal(error.code, "MEDIA_PROCESS_CLEANUP");
      assert.equal(error.globalSafety, true);
      assert.equal(error.originalReason, reason);
      return true;
    });
  });
}

test("default native abort reasons remain exact before and after spawning", async () => {
  for (const alreadyAborted of [true, false]) {
    const controller = new globalThis.AbortController();
    if (alreadyAborted) controller.abort(undefined);
    const running = run("setTimeout(()=>process.exit(),150)", {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    if (!alreadyAborted) controller.abort(undefined);
    assert.equal(controller.signal.reason.name, "AbortError");
    await assert.rejects(running, (error) => error === controller.signal.reason);
  }
});

test("missing abort reason uses the actionable interruption fallback", async () => {
  await assert.rejects(
    runMediaProcess("command-that-must-not-start", [], {
      signal: { aborted: true },
      label: "fixture provider",
    }),
    /fixture provider interrupted.*Retry in the next media worker window/,
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

test("unconfirmed cleanup preserves the checkpoint while overriding recovery with global safety", async () => {
  const controller = new globalThis.AbortController();
  const reason = new Error("private checkpoint fixture");
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
  await assert.rejects(running, (error) => {
    assert.equal(error.globalSafety, true);
    assert.equal(error.code, "MEDIA_PROCESS_CLEANUP");
    assert.equal(error.originalReason, reason);
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, "originalReason"), true);
    assert.equal(Object.propertyIsEnumerable.call(error, "originalReason"), false);
    assert.doesNotMatch(error.message, /private checkpoint fixture/);
    assert.doesNotMatch(JSON.stringify(error), /originalReason|private checkpoint fixture/);
    return true;
  });
});

test("cleanup denial preserves its cause and exact checkpoint without serializing either", async () => {
  const controller = new globalThis.AbortController();
  const reason = Object.assign(new Error("private checkpoint fixture"), {
    code: "MEDIA_CHECKPOINT",
    privateFixture: "private checkpoint detail",
  });
  const denial = Object.assign(new Error("private cleanup fixture"), {
    code: "EPERM",
    privateFixture: "private cleanup detail",
  });
  const groups = [];
  const running = run("setTimeout(()=>process.exit(),150)", {
    signal: controller.signal,
    timeoutMs: 1000,
    signalProcessGroup(pid, signal) {
      groups.push(pid);
      if (signal === "SIGTERM") {
        signalProcessGroup(pid, "SIGKILL");
        throw denial;
      }
      return signalProcessGroup(pid, signal);
    },
  });
  controller.abort(reason);
  await assert.rejects(running, (error) => {
    assert.equal(error.code, "MEDIA_PROCESS_CLEANUP");
    assert.equal(error.globalSafety, true);
    assert.equal(error.originalReason, reason);
    assert.equal(error.cause, denial);
    assert.doesNotMatch(error.message, /private/);
    assert.doesNotMatch(JSON.stringify(error), /originalReason|cause|private/);
    return true;
  });
  assert.equal(groups.length, 1);
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
  const directory = await mkdtemp(join(tmpdir(), "ntulearn-owned-escape-"));
  const stopPath = join(directory, "stop");
  const leaf = `const fs=require('node:fs');
    setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit()},20);
    setTimeout(()=>process.exit(),1800);`;
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)},${JSON.stringify(stopPath)}],{detached:true,stdio:'ignore'});
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
    try {
      await writeFile(stopPath, "stop", { mode: 0o600 });
      if (escapedPid) await waitForFixtureExit(escapedPid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function waitForFixtureExit(pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await setTimeout(10);
  }
  assert.fail("owned escaped fixture did not exit within its bound");
}
