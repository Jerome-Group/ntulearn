import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { withMediaQueueLock } from "../src/media/lock.mjs";

test("serializes media queue runs across lock contenders", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-lock-"));
  const statePath = join(root, "state.json");
  let release;
  const first = withMediaQueueLock({
    statePath,
    run: () => new Promise((resolve) => (release = resolve)),
  });

  while (!release) await setImmediate();
  await assert.rejects(
    withMediaQueueLock({ statePath, run: async () => "second" }),
    (error) => error.code === "MEDIA_QUEUE_LOCK_HELD",
  );

  release("first");
  assert.equal(await first, "first");
  assert.equal(
    await withMediaQueueLock({ statePath, run: async () => "after-release" }),
    "after-release",
  );
});
