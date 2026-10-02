import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { runMediaProcess } from "../src/media/process.mjs";

const leafScript = `
  const fs = require('node:fs');
  const path = process.argv[1];
  let heartbeat = 0;
  process.on('SIGTERM', () => {});
  const publish = () => {
    fs.writeFileSync(path + '.pending', JSON.stringify({pid: process.pid, heartbeat: ++heartbeat}), {mode: 0o600});
    fs.renameSync(path + '.pending', path);
  };
  publish();
  setInterval(() => {
    if (fs.existsSync(path + '.stop')) process.exit(0);
    publish();
  }, 20);
  setTimeout(() => process.exit(0), 4500);
`;

for (const trigger of ["timeout", "checkpoint"]) {
  for (const stdio of ["ignored", "inherited"]) {
    test(
      `${trigger}, ${stdio} stdio: originalGroup=passed; independentlyDetached=failed/unsupported`,
      {
        skip:
          process.platform === "win32"
            ? "originalGroup=unsupported; independentlyDetached=failed/unsupported: POSIX group signals unavailable"
            : false,
        timeout: 10_000,
      },
      async (context) => {
        const directory = await mkdtemp(join(tmpdir(), "ntulearn-owned-boundary-"));
        const registry = join(directory, "owned.json");
        const controller = new globalThis.AbortController();
        const checkpoint = Object.assign(new Error("checkpoint fixture"), {
          code: "MEDIA_CHECKPOINT",
        });
        const sentinel = spawn(process.execPath, ["-e", leafScript, join(directory, "sentinel")], {
          detached: true,
          stdio: "ignore",
        });
        const sentinelClosed = new Promise((resolve) => sentinel.once("close", resolve));
        sentinel.on("error", () => {});
        const ownedPids = new Set(sentinel.pid ? [sentinel.pid] : []);
        const signals = [];
        let originalGroup;
        let running;
        try {
          await waitFor(() => readHeartbeat(join(directory, "sentinel")), 1200);
          const script = providerScript(directory, registry, stdio);
          running = runMediaProcess(process.execPath, ["-e", script], {
            signal: controller.signal,
            timeoutMs: 2000,
            graceMs: 100,
            cleanupMs: 400,
            stdoutMaxBytes: 1024,
            stderrMaxBytes: 1024,
            label: "owned boundary fixture",
            signalProcessGroup(pid, signal) {
              originalGroup ??= pid;
              ownedPids.add(pid);
              assert.equal(pid, originalGroup);
              assert.notEqual(pid, sentinel.pid);
              signals.push({ pid, signal });
              return signalGroup(pid, signal);
            },
          }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          const identities = await waitFor(async () => {
            const registered = await readRegistry(registry);
            if (!registered) return false;
            for (const pid of Object.values(registered)) ownedPids.add(pid);
            if (!registered.sibling || !registered.escaped) return false;
            const [sibling, escaped] = await Promise.all(
              ["sibling", "escaped"].map((role) => readHeartbeat(join(directory, role))),
            );
            if (!sibling || !escaped) return false;
            assert.equal(sibling.pid, registered.sibling);
            assert.equal(escaped.pid, registered.escaped);
            return registered;
          }, 1200);
          if (trigger === "checkpoint") controller.abort(checkpoint);
          const { error } = await running;
          assert.ok(error, "cancellation must reject");
          assert.equal(originalGroup, identities.parent);
          assert.ok(signals.some(({ signal }) => signal === "SIGTERM"));
          assert.ok(signals.some(({ signal }) => signal === "SIGKILL"));
          assert.ok(signals.every(({ pid }) => pid === identities.parent));
          await waitFor(() => !isAlive(identities.parent) && !isAlive(identities.sibling), 1200);
          assert.equal(signalGroup(identities.parent, 0), false, "originalGroup=passed");
          await assertHeartbeatAdvances(join(directory, "escaped"), identities.escaped);
          await assertHeartbeatAdvances(join(directory, "sentinel"), sentinel.pid);
          assert.equal(sentinel.signalCode, null);
          assert.equal(sentinel.exitCode, null);
          assert.ok(signals.every(({ pid }) => pid !== sentinel.pid));
          const originalReason = stdio === "inherited" ? error.originalReason : error;
          assert.ok(originalReason instanceof Error);
          if (trigger === "checkpoint") assert.equal(originalReason, checkpoint);
          else assert.match(originalReason.message, /timed out/);
          if (stdio === "inherited") {
            assert.equal(error.code, "MEDIA_PROCESS_CLEANUP");
            assert.equal(error.globalSafety, true);
            assert.equal(Object.hasOwn(error, "originalReason"), true);
            assert.equal(Object.propertyIsEnumerable.call(error, "originalReason"), false);
          } else {
            assert.notEqual(error.code, "MEDIA_PROCESS_CLEANUP");
            assert.notEqual(error.globalSafety, true);
          }
          context.diagnostic(
            "originalGroup=passed; independentlyDetached=failed/unsupported; unrelatedOwnedSentinel=alive/unsignalled",
          );
        } finally {
          controller.abort(checkpoint);
          await Promise.all(
            ["parent", "sibling", "escaped", "sentinel"].map((role) =>
              writeFile(join(directory, role + ".stop"), "stop", { mode: 0o600 }),
            ),
          );
          if (running) await running;
          const expiryDeadline = performance.now() + 4500;
          try {
            await waitFor(async () => {
              const registered = await readRegistry(registry);
              if (registered) for (const pid of Object.values(registered)) ownedPids.add(pid);
              for (const role of ["sibling", "escaped", "sentinel"]) {
                const heartbeat = await readHeartbeat(join(directory, role));
                if (heartbeat) ownedPids.add(heartbeat.pid);
              }
              const spawningAccountedFor =
                (registered?.sibling && registered?.escaped) || performance.now() >= expiryDeadline;
              return spawningAccountedFor && [...ownedPids].every((pid) => !isAlive(pid));
            }, 5000);
            await sentinelClosed;
            assert.equal(sentinel.signalCode, null);
            assert.equal(sentinel.exitCode, 0);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
        const recovered = await runMediaProcess(
          process.execPath,
          ["-e", "process.stdout.write('recovered')"],
          {
            timeoutMs: 2000,
            graceMs: 100,
            cleanupMs: 400,
            stdoutMaxBytes: 1024,
            stderrMaxBytes: 1024,
            label: "owned recovery fixture",
            signalProcessGroup: signalGroup,
          },
        );
        assert.equal(recovered.stdout, "recovered");
      },
    );
  }
}

function providerScript(directory, registry, stdio) {
  const childStdio = stdio === "inherited" ? ["ignore", 1, 2] : "ignore";
  return `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 4500);
    const stopPath = ${JSON.stringify(join(directory, "parent.stop"))};
    if (fs.existsSync(stopPath)) process.exit(0);
    setInterval(() => {
      if (fs.existsSync(stopPath)) process.exit(0);
    }, 20);
    const owned = {parent: process.pid};
    const publish = () => {
      fs.writeFileSync(${JSON.stringify(registry + ".pending")}, JSON.stringify(owned), {mode: 0o600});
      fs.renameSync(${JSON.stringify(registry + ".pending")}, ${JSON.stringify(registry)});
    };
    publish();
    const sibling = spawn(process.execPath, ['-e', ${JSON.stringify(leafScript)}, ${JSON.stringify(join(directory, "sibling"))}], {stdio: 'ignore'});
    sibling.on('error', () => {});
    owned.sibling = sibling.pid;
    publish();
    const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(leafScript)}, ${JSON.stringify(join(directory, "escaped"))}], {detached: true, stdio: ${JSON.stringify(childStdio)}});
    escaped.on('error', () => {});
    escaped.unref();
    owned.escaped = escaped.pid;
    publish();
  `;
}

async function readRegistry(path) {
  const registered = await readFixtureJson(path);
  if (!registered) return null;
  assert.ok(
    Object.values(registered).every((pid) => Number.isSafeInteger(pid) && pid > 0),
    "fixture registry must contain positive spawned identities",
  );
  return registered;
}

async function readHeartbeat(path) {
  const heartbeat = await readFixtureJson(path);
  if (!heartbeat) return null;
  assert.ok(Number.isSafeInteger(heartbeat.pid) && heartbeat.pid > 0);
  assert.ok(Number.isSafeInteger(heartbeat.heartbeat) && heartbeat.heartbeat > 0);
  return heartbeat;
}

async function readFixtureJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertHeartbeatAdvances(path, pid) {
  const initial = await readHeartbeat(path);
  assert.equal(initial.pid, pid);
  await waitFor(async () => {
    const current = await readHeartbeat(path);
    assert.equal(current.pid, pid);
    return current.heartbeat > initial.heartbeat;
  }, 500);
}

async function waitFor(check, deadlineMs) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await setTimeout(10);
  }
  assert.fail("owned fixture deadline exceeded");
}

function isAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
