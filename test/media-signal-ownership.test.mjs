import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mediaQueueLockPath } from "../src/media/lock.mjs";
import { mediaDigestPaths } from "../src/media/digest.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { readMediaQueue } from "../src/media/queue.mjs";

async function signalFixture(t, mode, signal, repeated = false) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = fork(
    fileURLToPath(new URL("./fixtures/media-signal-runner.mjs", import.meta.url)),
    [root, mode],
    { silent: true },
  );
  let output = "",
    stderr = "",
    ownedChildPid;
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (stderr += data));
  const exit = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const deadline = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
  t.after(() => {
    globalThis.clearTimeout(deadline);
    child.kill("SIGKILL");
    if (ownedChildPid) {
      try {
        process.kill(ownedChildPid, "SIGKILL");
      } catch {
        /* Fixture already settled. */
      }
    }
  });
  const ready = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", () => reject(new Error("Fixture exited before launch: " + stderr + output)));
  });
  ownedChildPid = ready.ownedChildPid;
  const acknowledged = repeated ? new Promise((resolve) => child.once("message", resolve)) : null;
  child.kill(signal);
  if (repeated) {
    await acknowledged;
    child.kill(signal);
  }
  const result = await exit;
  globalThis.clearTimeout(deadline);
  assert.throws(() => process.kill(ownedChildPid, 0), { code: "ESRCH" });
  ownedChildPid = undefined;
  return { root, output, stderr, ...result, statePath: join(root, "state.json") };
}

test("real installed Playwright default SIGINT preempts checkpoint/report and retains fixture queue lock", async (t) => {
  const f = await signalFixture(t, "default", "SIGINT");
  assert.equal(f.code, 130);
  assert.equal(f.output, "");
  assert.equal(f.stderr, "");
  assert.ok(await stat(mediaQueueLockPath(f.statePath)));
  await assert.rejects(readFile(join(f.root, "checkpoint-settled")), { code: "ENOENT" });
  await assert.rejects(readFile(mediaDigestPaths(f.statePath).latestPath), { code: "ENOENT" });
});
for (const signal of ["SIGINT", "SIGTERM"])
  for (const repeated of [false, true]) {
    test(`media owns ${signal}${repeated ? " repeated" : ""} through checkpoint/browser close/lock release/digest`, async (t) => {
      const f = await signalFixture(t, "media", signal, repeated);
      assert.equal(f.code, 1);
      assert.equal(f.stderr, "");
      const digest = JSON.parse(f.output);
      assert.equal(digest.interrupted, true);
      assert.equal(digest.counts.checkpointed, 1);
      assert.equal(await readFile(join(f.root, "browser-closed"), "utf8"), "settled");
      assert.equal(await readFile(join(f.root, "checkpoint-settled"), "utf8"), "retained");
      await assert.rejects(stat(mediaQueueLockPath(f.statePath)), { code: "ENOENT" });
      assert.deepEqual(
        JSON.parse(await readFile(mediaDigestPaths(f.statePath).latestPath)),
        digest,
      );
      const queue = (await readMediaQueue({ statePath: f.statePath, courseKey: "FIXTURE" })).record
        .queue;
      assert.equal(queue[0].stage, "checkpointed");
      assert.equal(queue[0].complete, false);
    });
  }
test("caller-owned interruption preserves global browser cleanup failure over checkpoint success", async (t) => {
  const f = await signalFixture(t, "cleanup-failure", "SIGINT");
  assert.equal(f.code, 1);
  assert.equal(f.output, "");
  assert.match(f.stderr, /MEDIA_BROWSER_CLEANUP/);
  assert.equal(
    JSON.parse(await readFile(mediaDigestPaths(f.statePath).latestPath)).globalStop,
    true,
  );
  assert.ok(await readFile(mediaSafetyPath(f.statePath)));
  await assert.rejects(stat(mediaQueueLockPath(f.statePath)), { code: "ENOENT" });
});
