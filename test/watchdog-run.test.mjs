import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { runWatchdog, runWatchdogLocked } from "../src/watchdog/run.mjs";

let nextFakePid = 1_000;

test("writes a mount verdict without launching a command or creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const destination = join(root, "destination");
  const config = {
    statePath: join(root, ".data", "state.json"),
    driveMountPath: join(root, "missing-drive"),
    watchdogTimeoutMs: 1_000,
  };
  const runner = {
    spawn() {
      throw new Error("the mount pre-check should stop before spawning a command");
    },
  };

  const digest = await runWatchdogLocked({ config, root, runner });
  assert.equal(digest.verdict, "red");
  assert.equal(
    digest.message,
    "Drive not mounted — no run attempted; mount Google Drive, then run: npm run watchdog",
  );
  assert.match(digest.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(digest.runLog, /^logs\/.+\.json$/);
  await assert.rejects(stat(destination), { code: "ENOENT" });

  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  assert.equal(run.attempts, 0);
  assert.equal(run.preChecks.driveMount.present, false);
});

test("checks the Drive mount before acquiring the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const config = {
    statePath: join(root, ".data", "state.json"),
    driveMountPath: join(root, "missing-drive"),
    watchdogTimeoutMs: 1_000,
  };
  const runner = {
    lock() {
      throw new Error("the lock should not be acquired before the mount check");
    },
  };

  const result = await runWatchdog({ config, root, runner });
  assert.equal(result.exitCode, 1);
  assert.equal(
    result.digest.message,
    "Drive not mounted — no run attempted; mount Google Drive, then run: npm run watchdog",
  );
});

test("refuses before writing when a destination's Drive root is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  const driveRoot = join(driveMountPath, "My Drive");
  const destination = join(driveRoot, "Modules", "AB1234", "NTULearn");
  await mkdir(driveMountPath);
  const config = {
    statePath: join(root, ".data", "state.json"),
    driveMountPath,
    watchdogTimeoutMs: 1_000,
    courses: [{ key: "AB1234", destination }],
  };
  const runner = {
    spawn() {
      throw new Error("the destination pre-check should stop before spawning a command");
    },
  };

  const digest = await runWatchdogLocked({ config, root, runner });

  assert.equal(digest.verdict, "red");
  assert.equal(
    digest.message,
    `Destination ${destination} is unreachable — expected Drive root ${driveRoot}; set driveMountPath and the destination to the mounted Drive, then run: npm run watchdog`,
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });

  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  assert.equal(run.attempts, 0);
  assert.deepEqual(run.preChecks.destinations, [
    { path: destination, root: driveRoot, present: false },
  ]);
});

test("kills each timed-out attempt as a process group and retries three times", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const config = {
    statePath: join(root, ".data", "state.json"),
    driveMountPath,
    watchdogTimeoutMs: 5,
  };
  const commands = [];
  const killed = [];
  const children = new Map();
  const waits = [];
  const runner = {
    node: process.execPath,
    argumentsFor(command) {
      return [command];
    },
    spawn(_command, argumentsFor, options) {
      commands.push({ command: argumentsFor[0], options });
      const child = hangingChild("Chrome stopped responding");
      children.set(child.pid, child);
      return child;
    },
    killProcessGroup(pid) {
      killed.push(pid);
      const child = children.get(pid);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, "SIGKILL");
    },
  };

  const digest = await runWatchdogLocked({
    config,
    root,
    runner,
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(digest.verdict, "red");
  assert.equal(
    digest.message,
    "crash/timeout after 3 attempts; stderr tail: Chrome stopped responding; inspect the run log for the captured attempts",
  );
  assert.deepEqual(
    commands.map(({ command }) => command),
    ["sync", "sync", "sync"],
  );
  assert.equal(
    commands.every(({ options }) => options.detached),
    true,
  );
  assert.equal(killed.length, 3);
  assert.deepEqual(waits, [15 * 60 * 1000, 15 * 60 * 1000]);

  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  assert.equal(run.attempts, 3);
  assert.equal(run.attemptResults.length, 3);
  assert.equal(run.preChecks.history.length, 3);
  assert.equal(run.timeoutMs, 5);
  assert.equal(typeof run.durationMs, "number");
});

test("waits for timed-out children to close before retrying or publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const open = new Map();
  const settlements = [];
  const retryOpen = [];
  const runner = {
    node: process.execPath,
    argumentsFor: (command) => [command],
    spawn() {
      const child = hangingChild("Chrome stopped responding");
      open.set(child.pid, child);
      return child;
    },
    killProcessGroup(pid) {
      settlements.push(
        sleep(50).then(() => {
          const child = open.get(pid);
          open.delete(pid);
          child.stdout.end('{"courses":[]}');
          child.stderr.end("\nshutdown finished");
          child.emit("close", null, "SIGKILL");
        }),
      );
    },
  };

  const digest = await runWatchdogLocked({
    config: {
      statePath: join(root, ".data", "state.json"),
      driveMountPath,
      watchdogTimeoutMs: 5,
    },
    root,
    runner,
    wait: async () => retryOpen.push(open.size),
  });
  const openAtPublication = open.size;
  await Promise.all(settlements);

  assert.deepEqual(retryOpen, [0, 0]);
  assert.equal(openAtPublication, 0);
  assert.equal(open.size, 0);
  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  assert.equal(run.attempts, 3);
  assert.equal(
    run.attemptResults.every(({ sync }) => sync.timedOut),
    true,
  );
  assert.equal(
    run.attemptResults.every(({ sync }) => sync.signal === "SIGKILL"),
    true,
  );
  for (const { sync } of run.attemptResults) {
    assert.equal(sync.stdout, '{"courses":[]}');
    assert.deepEqual(sync.report, { courses: [] });
    assert.equal(sync.stderr, "Chrome stopped responding\nshutdown finished");
  }
});

test("preserves split UTF-8 stdout and stderr and clears completed command timers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const report = { courses: [], label: "über 中文 📚" };
  const stdout = JSON.stringify(report);
  const stderr = "über 中文 📚\n";
  const killed = [];
  const digest = await runWatchdogLocked({
    config: {
      statePath: join(root, ".data", "state.json"),
      driveMountPath,
      watchdogTimeoutMs: 20,
    },
    root,
    runner: {
      node: process.execPath,
      argumentsFor: (command) => [command],
      spawn() {
        const child = hangingChild("");
        process.nextTick(() => {
          for (const byte of Buffer.from(stdout)) child.stdout.write(Buffer.from([byte]));
          for (const byte of Buffer.from(stderr)) child.stderr.write(Buffer.from([byte]));
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
      killProcessGroup: (pid) => killed.push(pid),
    },
  });
  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  await sleep(30);

  for (const command of [run.sync, run.verify]) {
    assert.equal(command.stdout, stdout);
    assert.equal(command.stderr, stderr);
    assert.deepEqual(command.report, report);
  }
  assert.deepEqual(killed, []);
});

test("drains child errors through close before starting the next command", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const commands = [];
  const killed = [];
  let syncOpen = false;
  let verifyStartedWhileSyncOpen;
  const digest = await runWatchdogLocked({
    config: {
      statePath: join(root, ".data", "state.json"),
      driveMountPath,
      watchdogTimeoutMs: 20,
    },
    root,
    runner: {
      node: process.execPath,
      argumentsFor: (command) => [command],
      spawn(_command, [command]) {
        commands.push(command);
        if (command === "verify") {
          verifyStartedWhileSyncOpen = syncOpen;
          return completedChild({ code: 0, stdout: '{"courses":[]}' });
        }
        const child = hangingChild("");
        syncOpen = true;
        process.nextTick(() => {
          child.stdout.write('{"courses":[]}');
          child.stderr.write("before\n");
          child.emit("error", new Error("child failed"));
          setImmediate(() => {
            child.stdout.end("\n");
            child.stderr.end("after\n");
            syncOpen = false;
            child.emit("close", 1, null);
          });
        });
        return child;
      },
      killProcessGroup: (pid) => killed.push(pid),
    },
  });
  const run = JSON.parse(await readFile(join(root, ".data", digest.runLog), "utf8"));
  await sleep(30);

  assert.deepEqual(commands, ["sync", "verify"]);
  assert.equal(verifyStartedWhileSyncOpen, false);
  assert.equal(run.sync.stdout, '{"courses":[]}\n');
  assert.equal(run.sync.stderr, "before\nchild failed\nafter\n");
  assert.equal(run.sync.exitCode, 1);
  assert.equal(run.sync.signal, null);
  assert.equal(run.sync.timedOut, false);
  assert.deepEqual(killed, []);
});

test("rejects synchronous command spawn failures without publishing a digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const failure = new Error("spawn failed synchronously");
  await assert.rejects(
    runWatchdogLocked({
      config: {
        statePath: join(root, ".data", "state.json"),
        driveMountPath,
        watchdogTimeoutMs: 20,
      },
      root,
      runner: {
        node: process.execPath,
        argumentsFor: (command) => [command],
        spawn() {
          throw failure;
        },
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(stat(join(root, ".data", "latest.json")), { code: "ENOENT" });
});

test("does not retry a lapsed session or a completed red run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  await mkdir(driveMountPath);
  const baseConfig = {
    statePath: join(root, ".data", "state.json"),
    driveMountPath,
    watchdogTimeoutMs: 1_000,
  };
  const waits = [];
  const lapsedCommands = [];
  const lapsed = await runWatchdogLocked({
    config: baseConfig,
    root,
    runner: {
      node: process.execPath,
      argumentsFor(command) {
        return [command];
      },
      spawn(_command, argumentsFor) {
        lapsedCommands.push(argumentsFor[0]);
        return completedChild({
          code: 1,
          stderr: "The saved session is no longer signed in. Run: npm run login",
        });
      },
    },
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(lapsed.verdict, "red");
  assert.deepEqual(lapsedCommands, ["sync"]);
  assert.deepEqual(waits, []);

  const completedRedCommands = [];
  const completedRed = await runWatchdogLocked({
    config: { ...baseConfig, statePath: join(root, ".data", "red-state.json") },
    root,
    runner: {
      node: process.execPath,
      argumentsFor(command) {
        return [command];
      },
      spawn(_command, argumentsFor) {
        const command = argumentsFor[0];
        completedRedCommands.push(command);
        return command === "sync"
          ? completedChild({
              code: 1,
              stdout: JSON.stringify({
                courses: [{ failures: [{ file: "Guide.pdf", trail: "Week 1" }] }],
              }),
            })
          : completedChild({ code: 0, stdout: JSON.stringify({ complete: true, courses: [] }) });
      },
    },
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(completedRed.verdict, "red");
  assert.deepEqual(completedRedCommands, ["sync", "verify"]);
  assert.deepEqual(waits, []);
});

test("does not retry a destination permission failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-"));
  const driveMountPath = join(root, "Google Drive");
  const driveRoot = join(driveMountPath, "My Drive");
  const destination = join(driveRoot, "Modules", "AB1234", "NTULearn");
  await mkdir(destination, { recursive: true });
  const commands = [];
  const waits = [];

  const digest = await runWatchdogLocked({
    config: {
      statePath: join(root, ".data", "state.json"),
      driveMountPath,
      watchdogTimeoutMs: 1_000,
      courses: [{ key: "AB1234", destination }],
    },
    root,
    runner: {
      node: process.execPath,
      argumentsFor(command) {
        return [command];
      },
      spawn(_command, argumentsFor) {
        commands.push(argumentsFor[0]);
        return completedChild({
          code: 1,
          stderr: `EACCES: permission denied, mkdir '${destination}'`,
        });
      },
    },
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(commands, ["sync"]);
  assert.deepEqual(waits, []);
  assert.equal(digest.verdict, "red");
  assert.equal(
    digest.message,
    `Destination ${destination} is unreachable — permission denied at ${destination}; correct driveMountPath or destination permissions, then run: npm run watchdog`,
  );
  assert.doesNotMatch(digest.message, /crash|timeout/i);
});

function completedChild({ code, stdout = "", stderr = "" }) {
  const child = new EventEmitter();
  child.pid = nextFakePid++;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  process.nextTick(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  });
  return child;
}

function hangingChild(stderr) {
  const child = new EventEmitter();
  child.pid = nextFakePid++;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  process.nextTick(() => child.stderr.write(stderr));
  return child;
}
