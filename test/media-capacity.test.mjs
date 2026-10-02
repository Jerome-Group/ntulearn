import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createMediaCapacity } from "../src/media/capacity.mjs";

test("reserves prospective bytes on the artifact filesystem without hashing models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  const destination = join(root, "course");
  await mkdir(mediaRoot);
  let freeBytes = 200;
  const checked = [];
  const capacity = await createMediaCapacity(
    { mediaRoot, freeSpaceReserveBytes: 100 },
    {
      volumeRoot: root,
      courses: [{ destination }],
      statfs: async (path) => {
        checked.push(path);
        return { bavail: freeBytes, bsize: 1 };
      },
    },
  );
  await capacity.check({
    path: join(destination, "recording.mp4"),
    boundary: destination,
    bytes: 100,
  });
  await assert.rejects(
    capacity.check({ path: join(destination, "recording.mp4"), boundary: destination, bytes: 101 }),
    /reserve.*Free space/,
  );
  assert.ok(checked.includes(root));
  freeBytes = 99;
  await assert.rejects(capacity.checkJob({ destination }), /reserve/);
  freeBytes = 200;
  await capacity.checkJob({ destination });
  await assert.rejects(
    createMediaCapacity(
      { mediaRoot, freeSpaceReserveBytes: 100 },
      { volumeRoot: root, statfs: async () => ({}) },
    ),
    /space evidence/,
  );
});

test("rejects replaced storage roots and symlinked scratch before acquiring", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-capacity-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  await mkdir(join(mediaRoot, ".runtime", "work"), { recursive: true });
  const options = { volumeRoot: root, statfs: async () => ({ bavail: 200n, bsize: 1n }) };
  const capacity = await createMediaCapacity({ mediaRoot, freeSpaceReserveBytes: 100 }, options);
  await rename(mediaRoot, join(root, "retained"));
  await mkdir(mediaRoot);
  await assert.rejects(capacity.check(), /changed/);
  await rm(mediaRoot, { recursive: true });
  await rename(join(root, "retained"), mediaRoot);
  await capacity.check();
  const scratch = join(mediaRoot, ".runtime", "work");
  await rename(scratch, join(mediaRoot, "retained-work"));
  await symlink(join(mediaRoot, "retained-work"), scratch);
  await assert.rejects(capacity.check(), /symlink|changed/);
  await writeFile(join(mediaRoot, "original.txt"), "original");
});

test("bounds unresolved space probes at initialization and subsequent checks, then recovers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-capacity-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  await mkdir(mediaRoot);
  const media = { mediaRoot, freeSpaceReserveBytes: 100 };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // MockTimers does not update the production module's named timer imports on its own.
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  let probe;
  const options = { volumeRoot: root, statfs: (...args) => probe(...args) };
  async function expiresAtDefaultDeadline(start) {
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    probe = () => {
      entered();
      return new Promise(() => {});
    };
    let settled = false;
    const running = start();
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(running, {
      code: "MEDIA_CAPACITY_TIMEOUT",
      globalSafety: true,
    });
    await ready;
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
  }
  await expiresAtDefaultDeadline(() => createMediaCapacity(media, options));
  probe = async () => ({ bavail: 200n, bsize: 1n });
  const capacity = await createMediaCapacity(media, options);
  await expiresAtDefaultDeadline(() => capacity.checkJob({}));
  probe = async () => ({ bavail: 200n, bsize: 1n });
  await capacity.checkJob({});
});
