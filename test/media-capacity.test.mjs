import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
  realpath,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { queueCourseBoundary } from "../src/media/queue-course.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";
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
      code: "MEDIA_FILE_CLEANUP",
      globalSafety: true,
    });
    await ready;
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    for (let step = 0; step < 20; step++) await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(5000);
    await rejected;
  }
  await expiresAtDefaultDeadline(() => createMediaCapacity(media, options));
  probe = async () => ({ bavail: 200n, bsize: 1n });
  const capacity = await createMediaCapacity(media, options);
  await expiresAtDefaultDeadline(() => capacity.checkJob({}));
  probe = async () => ({ bavail: 200n, bsize: 1n });
  await capacity.checkJob({});
});

async function aliasFixture(t, configuredAlias = false) {
  const temporary = await mkdtemp(join(tmpdir(), "ntulearn-capacity-alias-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "actual"),
    alias = join(root, "alias");
  const destination = join(parent, "course"),
    retained = join(alias, "course");
  const mediaRoot = join(root, "Media");
  await mkdir(destination, { recursive: true });
  await mkdir(mediaRoot);
  await symlink(parent, alias);
  const course = {
    key: "fixture",
    courseId: "fixture-course",
    destination: configuredAlias ? retained : destination,
  };
  const placement = {
    destination: configuredAlias ? destination : retained,
    formattedTranscriptPath: "Lecture.transcript.md",
  };
  const appearance = {
    recordingId: "content-tree:fixture-course:item",
    courseId: course.courseId,
    storageSurface: "content-tree",
    placement,
  };
  const media = { mediaRoot, freeSpaceReserveBytes: 100 };
  const capacity = await createMediaCapacity(media, {
    volumeRoot: root,
    courses: [course],
    statfs: async () => ({ bavail: 100000n, bsize: 1n }),
  });
  return {
    root,
    parent,
    alias,
    destination,
    retained,
    mediaRoot,
    course,
    appearance,
    media,
    capacity,
  };
}
for (const configuredAlias of [false, true])
  test(`accepted course alias publishes unchanged bytes (${configuredAlias})`, async (t) => {
    const f = await aliasFixture(t, configuredAlias),
      before = JSON.stringify(f.appearance);
    const boundary = queueCourseBoundary({ course: f.course });
    await boundary.assert([f.appearance], f.course.courseId);
    await f.capacity.checkJob(f.course);
    await writeFile(join(f.destination, "student.md"), "Student annotations.");
    const storage = createMediaStorage({
      mediaRoot: f.mediaRoot,
      volumeRoot: f.root,
      checkCapacity: f.capacity.check,
    });
    await storage.write({
      appearance: f.appearance,
      kind: "formatted-transcript",
      content: "Preserved fixture words.",
    });
    assert.equal(
      await readFile(join(f.destination, "Lecture.transcript.md"), "utf8"),
      "Preserved fixture words.",
    );
    assert.equal(JSON.stringify(f.appearance), before);
    assert.equal(await readFile(join(f.destination, "student.md"), "utf8"), "Student annotations.");
  });

test("course aliases reject unrelated boundaries and retargeting, then accept restored identity", async (t) => {
  const f = await aliasFixture(t),
    foreign = join(f.root, "foreign");
  await mkdir(join(foreign, "course"), { recursive: true });
  for (const boundary of [foreign, f.parent, join(f.destination, "nested")]) {
    await assert.rejects(f.capacity.check({ path: join(boundary, "file.md"), boundary }), {
      code: "MEDIA_CAPACITY_DESTINATION_UNVERIFIED",
      globalSafety: true,
    });
  }
  await f.capacity.check({ path: join(f.retained, "file.md"), boundary: f.retained });
  await rm(f.alias);
  await symlink(foreign, f.alias);
  await assert.rejects(
    f.capacity.check({ path: join(f.retained, "file.md"), boundary: f.retained }),
    { code: "MEDIA_CAPACITY_DESTINATION_UNVERIFIED", globalSafety: true },
  );
  await rm(f.alias);
  await symlink(f.parent, f.alias);
  await f.capacity.check({ path: join(f.retained, "file.md"), boundary: f.retained });
  await rename(f.destination, f.destination + "-original");
  await mkdir(f.destination);
  await assert.rejects(
    f.capacity.check({ path: join(f.retained, "file.md"), boundary: f.retained }),
    { code: "MEDIA_CAPACITY_DESTINATION_UNVERIFIED", globalSafety: true },
  );
  await rm(f.destination, { recursive: true });
  await rename(f.destination + "-original", f.destination);
  await f.capacity.check({ path: join(f.retained, "file.md"), boundary: f.retained });
});

test("alias binding remains current through free-space probe and artifact symlinks still refuse", async (t) => {
  const f = await aliasFixture(t),
    foreign = join(f.root, "foreign");
  await mkdir(join(foreign, "course"), { recursive: true });
  let retarget = false,
    space = 100000n;
  const capacity = await createMediaCapacity(f.media, {
    volumeRoot: f.root,
    courses: [f.course],
    statfs: async () => {
      if (retarget) {
        await rm(f.alias);
        await symlink(foreign, f.alias);
      }
      return { bavail: space, bsize: 1n };
    },
  });
  const request = { path: join(f.retained, "file.md"), boundary: f.retained, bytes: 10 };
  retarget = true;
  await assert.rejects(capacity.check(request), { globalSafety: true });
  retarget = false;
  await rm(f.alias);
  await symlink(f.parent, f.alias);
  await capacity.check(request);
  space = 109n;
  await assert.rejects(capacity.check(request), /reserve/);
  space = 110n;
  await capacity.check(request);
  await symlink(foreign, join(f.destination, "linked"));
  await assert.rejects(
    capacity.check({ path: join(f.retained, "linked", "file.md"), boundary: f.retained }),
    /symlink/,
  );
  const leafAlias = join(f.root, "leaf-alias");
  await symlink(f.destination, leafAlias);
  await assert.rejects(
    capacity.check({ path: join(leafAlias, "file.md"), boundary: leafAlias }),
    /symlink/,
  );
});
