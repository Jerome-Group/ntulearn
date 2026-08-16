import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mediaQueuePath,
  readMediaQueue,
  withdrawQueuedRecording,
  writeMediaQueue,
} from "../src/media/queue.mjs";

const COURSE = { key: "MH1101", courseId: "_9_1" };

test("writes a complete Gallery queue as a reconstructible state artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const saved = await writeMediaQueue({
    statePath: join(root, "state.json"),
    course: COURSE,
    discovery: {
      complete: true,
      verdict: "green",
      displayedCount: 1,
      discoveredCount: 1,
      queue: [{ recordingId: "gallery-1" }],
      limitations: [],
    },
    now: () => new Date("2026-08-16T01:02:03.000Z"),
  });

  assert.equal(saved.path, mediaQueuePath(join(root, "state.json"), COURSE.key));
  assert.deepEqual(JSON.parse(await readFile(saved.path, "utf8")), {
    version: 1,
    courseKey: "MH1101",
    courseId: "_9_1",
    complete: true,
    verdict: "green",
    displayedCount: 1,
    discoveredCount: 1,
    queue: [{ recordingId: "gallery-1" }],
    limitations: [],
    updatedAt: "2026-08-16T01:02:03.000Z",
  });
});

test("writes no queue jobs when discovery is red", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const saved = await writeMediaQueue({
    statePath: join(root, "state.json"),
    course: COURSE,
    discovery: {
      complete: false,
      verdict: "red",
      displayedCount: 3,
      discoveredCount: 1,
      queue: [{ recordingId: "false-subset" }],
      limitations: ["count mismatch"],
    },
  });

  const persisted = JSON.parse(await readFile(saved.path, "utf8"));
  assert.equal(persisted.complete, false);
  assert.deepEqual(persisted.queue, []);
  assert.deepEqual(persisted.limitations, ["count mismatch"]);
});

test("keeps prior job state on red rediscovery and merges it on the next green run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  const prior = {
    recordingId: "gallery-1",
    title: "Old title",
    complete: true,
    stage: "complete",
    withdrawn: true,
    artifacts: { media: "/Volumes/RAID0/Media/recordings/one/media/lecture.mp4" },
  };
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [prior] },
  });

  const red = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: false, verdict: "red", queue: [] },
  });
  assert.equal(red.status, "unchanged");
  const preserved = JSON.parse(await readFile(red.path, "utf8"));
  assert.deepEqual(preserved.queue, [prior]);

  const green = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: {
      complete: true,
      queue: [
        { recordingId: "gallery-1", title: "New title" },
        { recordingId: "gallery-2", title: "New recording" },
      ],
    },
  });
  const merged = JSON.parse(await readFile(green.path, "utf8"));
  assert.equal(merged.queue[0].title, "New title");
  assert.equal(merged.queue[0].complete, true);
  assert.equal(merged.queue[0].withdrawn, true);
  assert.deepEqual(merged.queue[0].artifacts, prior.artifacts);
  assert.deepEqual(merged.queue[1], { recordingId: "gallery-2", title: "New recording" });

  const reappeared = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1", title: "Reappeared" }] },
  });
  const restored = JSON.parse(await readFile(reappeared.path, "utf8"));
  assert.equal(restored.queue[0].title, "Reappeared");
  assert.equal(restored.queue[0].withdrawn, true);
});

test("keeps a withdrawn tombstone when the next green discovery omits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  const withdrawn = {
    recordingId: "gallery-old",
    withdrawn: true,
    complete: false,
    artifacts: { media: "/Volumes/RAID0/Media/old.mp4" },
  };
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [withdrawn] },
  });
  const saved = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-new" }] },
  });

  const persisted = JSON.parse(await readFile(saved.path, "utf8"));
  assert.deepEqual(persisted.queue, [{ recordingId: "gallery-new" }, withdrawn]);
});

test("requires confirmation and persists a confirmed withdrawal tombstone", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const queue = [
    {
      recordingId: "gallery-1",
      complete: false,
      artifacts: { media: "/Volumes/RAID0/Media/recordings/one/media/lecture.mp4" },
    },
    { recordingId: "gallery-2", complete: true },
  ];
  const discovery = {
    complete: true,
    verdict: "green",
    displayedCount: 2,
    discoveredCount: 2,
    queue,
    limitations: [],
  };

  const needsConfirmation = withdrawQueuedRecording({
    queue,
    recordingId: "gallery-1",
    confirmed: false,
  });
  assert.equal(needsConfirmation.status, "confirmation-required");

  const saved = await writeMediaQueue({
    statePath: join(root, "state.json"),
    course: COURSE,
    discovery,
    withdrawal: { recordingId: "gallery-1", confirmed: true },
  });
  const persisted = JSON.parse(await readFile(saved.path, "utf8"));
  assert.equal(saved.status, "withdrawn");
  assert.equal(persisted.queue[0].stage, "withdrawn");
  assert.equal(persisted.queue[0].withdrawn, true);
  assert.deepEqual(persisted.queue[0].artifacts, queue[0].artifacts);
  assert.equal(persisted.queue[1].complete, true);
});

test("reads a durable queue for the explicit withdrawal command", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1" }] },
  });

  const loaded = await readMediaQueue({ statePath, courseKey: COURSE.key });
  assert.equal(loaded.path, mediaQueuePath(statePath, COURSE.key));
  assert.deepEqual(loaded.record.queue, [{ recordingId: "gallery-1" }]);
});
