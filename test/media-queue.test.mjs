import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mediaQueuePath,
  readMediaQueue,
  updateMediaQueueJob,
  withdrawQueuedRecording,
  writeMediaQueue,
} from "../src/media/queue.mjs";

const COURSE = {
  key: "MH1101",
  courseId: "_9_1",
  mediaMode: "pilot",
};

test("writes course and queued recording status documents at discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-status-"));
  const course = { ...COURSE, destination: join(root, "course") };
  const appearance = {
    recordingId: "media-gallery:_9_1:gallery-1",
    title: "Week 1",
    provider: "kaltura",
    sourceKind: "media-gallery",
    placement: {
      destination: course.destination,
      statusPath: "Media Gallery/Week 1.media-status.md",
    },
  };
  const saved = await writeMediaQueue({
    statePath: join(root, "state.json"),
    course,
    discovery: { complete: true, verdict: "green", queue: [appearance] },
  });

  assert.equal(saved.statusPath, join(course.destination, "Media Gallery/media-status.md"));
  assert.match(await readFile(saved.statusPath, "utf8"), /Week 1/);
  assert.match(
    await readFile(
      appearance.placement.statusPath.startsWith("/")
        ? appearance.placement.statusPath
        : join(course.destination, appearance.placement.statusPath),
      "utf8",
    ),
    /Stage: queued/,
  );
});

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

test("retains an unconfirmed prior appearance when green discovery omits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-retention-"));
  const statePath = join(root, "state.json");
  const prior = {
    recordingId: "gallery-failed",
    stage: "failed",
    complete: false,
    retryable: true,
    attempts: 2,
    limitations: ["source unavailable"],
  };
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [prior] },
  });

  const saved = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-new" }] },
  });

  assert.deepEqual((await readMediaQueue({ statePath, courseKey: COURSE.key })).record.queue, [
    { recordingId: "gallery-new" },
    prior,
  ]);
  assert.equal(saved.status, "written");
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

test("marks a withdrawn appearance without deleting its acquired artifact evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-withdrawal-status-"));
  const statePath = join(root, "state.json");
  const course = { ...COURSE, destination: join(root, "course") };
  const appearance = {
    recordingId: "media-gallery:_9_1:gallery-1",
    title: "Withdrawn lecture",
    provider: "kaltura",
    sourceKind: "media-gallery",
    placement: {
      destination: course.destination,
      statusPath: "Media Gallery/Withdrawn lecture.media-status.md",
    },
  };
  const discovery = {
    complete: true,
    verdict: "green",
    queue: [
      {
        ...appearance,
        artifacts: { media: "/Volumes/RAID0/Media/recordings/lecture.mp4" },
      },
    ],
  };
  await writeMediaQueue({ statePath, course, discovery });
  await writeMediaQueue({
    statePath,
    course,
    discovery,
    withdrawal: { recordingId: appearance.recordingId, confirmed: true },
  });

  const recordingStatus = await readFile(
    join(course.destination, appearance.placement.statusPath),
    "utf8",
  );
  const courseStatus = await readFile(
    join(course.destination, "Media Gallery/media-status.md"),
    "utf8",
  );
  assert.match(recordingStatus, /Stage: withdrawn/);
  assert.match(recordingStatus, /acquired artifacts retained/);
  assert.match(courseStatus, /Withdrawn: 1/);
  assert.match(
    (await readMediaQueue({ statePath, courseKey: course.key })).record.queue[0].artifacts.media,
    /lecture\.mp4$/,
  );
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

test("updates one queued appearance without dropping the rest of the durable queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: {
      complete: true,
      queue: [{ recordingId: "gallery-1" }, { recordingId: "gallery-2" }],
    },
  });

  const saved = await updateMediaQueueJob({
    statePath,
    courseKey: COURSE.key,
    recordingId: "gallery-1",
    update: {
      stage: "checkpointed",
      complete: false,
      retryable: true,
      duration: 123.4,
      speechDuration: 120,
    },
    now: () => new Date("2026-08-16T04:00:00.000Z"),
  });

  assert.equal(saved.job.stage, "checkpointed");
  assert.deepEqual(saved.record.queue, [
    {
      recordingId: "gallery-1",
      stage: "checkpointed",
      complete: false,
      retryable: true,
      duration: 123.4,
      speechDuration: 120,
    },
    { recordingId: "gallery-2" },
  ]);
  assert.equal(saved.record.updatedAt, "2026-08-16T04:00:00.000Z");
  assert.deepEqual(
    (await readMediaQueue({ statePath, courseKey: COURSE.key })).record,
    saved.record,
  );
});

test("retains prior failure limitations when a retry records another failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-history-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: {
      complete: true,
      queue: [{ recordingId: "gallery-1", limitations: ["first failure"] }],
    },
  });

  const saved = await updateMediaQueueJob({
    statePath,
    courseKey: COURSE.key,
    recordingId: "gallery-1",
    update: { stage: "failed", complete: false, retryable: true, limitations: ["second failure"] },
  });

  assert.deepEqual(saved.job.limitations, ["first failure", "second failure"]);
});

test("rejects execution-time URLs at the durable queue boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1" }] },
  });

  await assert.rejects(
    updateMediaQueueJob({
      statePath,
      courseKey: COURSE.key,
      recordingId: "gallery-1",
      update: { resolvedUrl: "https://provider.example.test/expiring?token=secret" },
    }),
    /unsupported fields: resolvedUrl/,
  );
});

test("rejects non-numeric duration evidence at the durable queue boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-duration-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1" }] },
  });

  await assert.rejects(
    updateMediaQueueJob({
      statePath,
      courseKey: COURSE.key,
      recordingId: "gallery-1",
      update: { duration: true },
    }),
    /duration must be a positive number/,
  );
});
