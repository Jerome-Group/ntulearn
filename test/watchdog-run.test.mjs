import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
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
  const waits = [];
  const runner = {
    node: process.execPath,
    argumentsFor(command) {
      return [command];
    },
    spawn(_command, argumentsFor, options) {
      commands.push({ command: argumentsFor[0], options });
      return hangingChild("Chrome stopped responding");
    },
    killProcessGroup(pid) {
      killed.push(pid);
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
  process.nextTick(() => child.stderr.end(stderr));
  return child;
}
