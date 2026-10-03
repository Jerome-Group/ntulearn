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
    discovery: {
      complete: false,
      verdict: "red",
      queue: [{ recordingId: "false-subset" }],
      displayedCount: 7,
      discoveredCount: 2,
      contentCount: 1,
      galleryCount: 0,
      limitations: ["Pagination incomplete; inspect Media Gallery then retry discovery."],
    },
    now: () => new Date("2026-10-03T01:02:03.000Z"),
  });
  assert.equal(red.status, "written");
  const preserved = JSON.parse(await readFile(red.path, "utf8"));
  assert.deepEqual(preserved.queue, [prior]);
  assert.equal(preserved.complete, false);
  assert.equal(preserved.verdict, "red");
  assert.equal(preserved.displayedCount, 7);
  assert.equal(preserved.discoveredCount, 2);
  assert.equal(preserved.contentCount, 1);
  assert.equal(preserved.galleryCount, 0);
  assert.equal(preserved.updatedAt, "2026-10-03T01:02:03.000Z");
  assert.match(preserved.limitations[0], /retry discovery/);
  assert.equal(
    (await readMediaQueue({ statePath, courseKey: COURSE.key, course: COURSE })).record.complete,
    false,
  );

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
  assert.equal(merged.complete, true);
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

test("drops invalid retained durations during green queue reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-queue-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1", duration: 0 }] },
  });

  const saved = await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: { complete: true, queue: [{ recordingId: "gallery-1" }] },
  });

  const persisted = JSON.parse(await readFile(saved.path, "utf8"));
  assert.equal(Object.hasOwn(persisted.queue[0], "duration"), false);
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

test("distinct unsafe course keys never share a queue", () => {
  assert.notEqual(
    mediaQueuePath("/fixture/state.json", "A/B"),
    mediaQueuePath("/fixture/state.json", "A?B"),
  );
});

test("rediscovery retains established placement through title and order changes", async () => {
  let record = null;
  const read = async () => {
    if (!record) {
      const error = new Error("absent");
      error.code = "ENOENT";
      throw error;
    }
    return JSON.stringify(record);
  };
  const write = async (_, value) => {
    record = JSON.parse(value);
  };
  const placement = {
    destination: "/fixture/course",
    videoPath: "01 Old.mp4",
    formattedTranscriptPath: "01 Old.transcript.md",
    statusPath: "01 Old.media-status.md",
  };
  const prior = {
    recordingId: "one",
    placement,
    complete: true,
    transcript: { complete: true },
    artifacts: { formattedTranscript: "/fixture/course/01 Old.transcript.md" },
  };
  await writeMediaQueue({
    statePath: "/fixture/state.json",
    course: COURSE,
    discovery: { complete: true, queue: [prior] },
    read,
    write,
  });
  await writeMediaQueue({
    statePath: "/fixture/state.json",
    course: COURSE,
    discovery: {
      complete: true,
      queue: [{ ...prior, title: "New", placement: { ...placement, videoPath: "02 New.mp4" } }],
    },
    read,
    write,
  });
  assert.deepEqual(record.queue[0].placement, placement);
  assert.equal(record.queue[0].title, "New");
});

test("refuses a retained queue belonging to another course", async () => {
  await assert.rejects(
    writeMediaQueue({
      statePath: "/fixture/state.json",
      course: COURSE,
      discovery: { complete: true, queue: [] },
      read: async () => JSON.stringify({ courseKey: COURSE.key, courseId: "_99_1", queue: [] }),
      write: async () => assert.fail("must not write"),
    }),
    /another course/i,
  );
});

test("reads a proven legacy queue without moving its established artifacts", async () => {
  const course = { ...COURSE, key: "A/B" };
  const prior = {
    courseKey: course.key,
    courseId: course.courseId,
    queue: [
      {
        recordingId: "one",
        placement: { destination: "/fixture/course", formattedTranscriptPath: "Old.transcript.md" },
        complete: true,
        transcript: { complete: true },
      },
    ],
  };
  const read = async (path) => {
    if (path.endsWith("A_B.json")) return JSON.stringify(prior);
    const error = new Error("absent");
    error.code = "ENOENT";
    throw error;
  };
  const loaded = await readMediaQueue({
    statePath: "/fixture/state.json",
    courseKey: course.key,
    course,
    read,
  });
  assert.deepEqual(loaded.record, prior);
  assert.match(loaded.path, /A%2FB\.json$/);
  const other = await readMediaQueue({
    statePath: "/fixture/state.json",
    courseKey: "A?B",
    course: { ...course, key: "A?B" },
    read,
  });
  assert.equal(other.record, null);
});

test("retains but blocks legacy recordings whose artifact placements collide", async () => {
  const placement = {
    destination: "/fixture/course",
    formattedTranscriptPath: "Shared.transcript.md",
  };
  const queue = ["one", "two"].map((recordingId) => ({
    recordingId,
    placement,
    complete: true,
    transcript: { complete: true },
  }));
  let saved;
  await writeMediaQueue({
    statePath: "/fixture/state.json",
    course: COURSE,
    discovery: { complete: true, queue },
    read: async () => JSON.stringify({ courseKey: COURSE.key, courseId: COURSE.courseId, queue }),
    write: async (_, value) => {
      saved = JSON.parse(value);
    },
  });
  assert.deepEqual(
    saved.queue.map((job) => job.placement),
    [placement, placement],
  );
  assert.equal(
    saved.queue.every((job) => !job.complete && job.retryable === false),
    true,
  );
});

test("fresh evidenced disposition preserves a legacy appearance and recovery history", async () => {
  const course = { key: "fixture", courseId: "_fixture_1", destination: "/fixture/course" };
  const statePath = "/fixture/state.json";
  const old = {
    recordingId: "legacy-id",
    itemId: "item",
    sourceKind: "attachment",
    provider: "unsupported",
    providerReference: "unsupported:ntulearn-file:ntulearn.ntu.edu.sg/bbcswebdav/resource",
    placement: {
      destination: course.destination,
      statusPath: "Old.media-status.md",
      formattedTranscriptPath: "Old.transcript.md",
    },
    stage: "failed",
    retryable: false,
    attempts: 4,
    lastError: "prior failure",
    artifacts: { metadata: "/fixture/held-metadata.json" },
  };
  let record = { courseKey: course.key, courseId: course.courseId, complete: true, queue: [old] };
  const read = async (path) => (path.includes("media-queue") ? JSON.stringify(record) : null);
  const write = async (path, body) => {
    if (path.endsWith(".json")) record = JSON.parse(body);
  };
  const discover = async (appearance) =>
    writeMediaQueue({
      statePath,
      course,
      discovery: { complete: true, verdict: "green", queue: [appearance] },
      read,
      write,
    });
  const fresh = {
    ...old,
    recordingId: "fresh-id",
    candidateReference: "candidate:ntulearn.ntu.edu.sg/bbcswebdav/resource",
    disposition: "non-recording",
    classificationEvidence: "document",
    placement: { ...old.placement, statusPath: "New.media-status.md" },
  };
  await discover(fresh);
  assert.equal(record.queue.length, 1);
  assert.equal(record.queue[0].recordingId, "legacy-id");
  assert.equal(record.queue[0].attempts, 4);
  assert.deepEqual(record.queue[0].artifacts, old.artifacts);
  assert.deepEqual(record.queue[0].placement, old.placement);
  await discover({
    ...fresh,
    provider: "direct",
    providerReference: "direct:ntulearn.ntu.edu.sg/bbcswebdav/resource",
    disposition: "recording",
    classificationEvidence: "media",
  });
  assert.equal(record.queue[0].recordingId, "legacy-id");
  assert.equal(record.queue[0].stage, "queued");
  assert.equal(record.queue[0].retryable, true);
  assert.equal(record.queue[0].lastError, "prior failure");
  assert.equal(record.queue[0].attempts, 4);
  await discover({
    ...fresh,
    provider: "direct",
    providerReference: "direct:ntulearn.ntu.edu.sg/bbcswebdav/resource",
    disposition: "recording",
    classificationEvidence: "media",
  });
  assert.equal(record.queue.length, 1);
  await writeMediaQueue({
    statePath,
    course,
    discovery: { complete: true, queue: [] },
    read,
    write,
  });
  assert.equal(record.queue.length, 1);
});

test("fresh document evidence never hides retained transcripts or transfers ambiguous legacy ownership", async () => {
  const course = { key: "fixture", courseId: "_fixture_1", destination: "/fixture/course" };
  const old = {
    recordingId: "legacy",
    itemId: "item",
    sourceKind: "attachment",
    provider: "unsupported",
    providerReference: "unsupported:ntulearn-file:ntulearn.ntu.edu.sg/asset",
    artifacts: { rawTranscript: "/fixture/source.json" },
    attempts: 3,
  };
  let record = { courseKey: course.key, courseId: course.courseId, queue: [old] };
  const read = async () => JSON.stringify(record);
  const write = async (path, body) => {
    if (path.endsWith(".json")) record = JSON.parse(body);
  };
  const fresh = {
    recordingId: "new",
    itemId: "item",
    sourceKind: "attachment",
    provider: "unsupported",
    candidateReference: "candidate:ntulearn.ntu.edu.sg/asset",
    disposition: "non-recording",
    classificationEvidence: "document",
  };
  await writeMediaQueue({
    statePath: "/fixture/state.json",
    course,
    discovery: { complete: true, queue: [fresh] },
    read,
    write,
  });
  assert.equal(record.queue[0].recordingId, "legacy");
  assert.equal(record.queue[0].disposition, "unresolved");
  assert.deepEqual(record.queue[0].artifacts, old.artifacts);
  record = { ...record, queue: [old, { ...old, recordingId: "second-owner" }] };
  await writeMediaQueue({
    statePath: "/fixture/state.json",
    course,
    discovery: { complete: true, queue: [fresh] },
    read,
    write,
  });
  assert.deepEqual(
    record.queue.map((job) => job.recordingId),
    ["new", "legacy", "second-owner"],
  );
  assert.deepEqual(record.queue[1].artifacts, old.artifacts);
});

test("physical destination aliases preserve read, merge and update ownership", async (t) => {
  const { mkdir, symlink, writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-queue-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course");
  const alias = join(root, "alias");
  await mkdir(destination);
  await symlink(destination, alias);
  const course = { ...COURSE, destination };
  const statePath = join(root, "state.json");
  const checkpoint = { at: "2026-10-03T00:00:00Z", reason: "Synthetic checkpoint" };
  const source = join(alias, "source.json");
  const edited = join(alias, "Lecture.transcript.md");
  await writeFile(source, "Preserved synthetic source");
  await writeFile(edited, "Student edited derivative");
  const job = {
    recordingId: "synthetic-recording",
    courseKey: course.key,
    courseId: course.courseId,
    title: "Lecture",
    provider: "kaltura",
    providerReference: "entry:stable",
    sourceKind: "content-tree",
    disposition: "recording",
    stage: "failed",
    attempts: 3,
    checkpoint,
    artifacts: { rawTranscript: source, formattedTranscript: edited },
    placement: {
      destination: alias,
      videoPath: "Lecture.mp4",
      formattedTranscriptPath: "Lecture.transcript.md",
      statusPath: "Lecture.media-status.md",
    },
  };
  const path = mediaQueuePath(statePath, course.key);
  await mkdir(join(root, "media-queue"));
  await writeFile(
    path,
    JSON.stringify({
      courseKey: course.key,
      courseId: course.courseId,
      complete: true,
      queue: [job],
    }),
  );
  const read = await readMediaQueue({ statePath, courseKey: course.key, course });
  assert.equal(read.record.queue[0].placement.destination, alias);
  await writeMediaQueue({
    statePath,
    course,
    discovery: {
      complete: true,
      queue: [{ ...job, placement: { ...job.placement, destination } }],
    },
  });
  const updated = await updateMediaQueueJob({
    statePath,
    courseKey: course.key,
    course,
    recordingId: job.recordingId,
    update: { attempts: 4 },
  });
  assert.deepEqual(updated.job.placement, job.placement);
  assert.deepEqual(updated.job.artifacts, job.artifacts);
  assert.deepEqual(updated.job.checkpoint, checkpoint);
  assert.equal(updated.job.attempts, 4);
  assert.equal(await readFile(source, "utf8"), "Preserved synthetic source");
  assert.equal(await readFile(edited, "utf8"), "Student edited derivative");
});

test("unverified destinations refuse read, publication and update before changing owned bytes", async (t) => {
  const { mkdir, symlink, writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-queue-alias-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course");
  const other = join(root, "other-course");
  const alias = join(root, "alias");
  await mkdir(destination);
  await mkdir(other);
  await mkdir(join(root, "media-queue"));
  const course = { ...COURSE, destination };
  const statePath = join(root, "state.json");
  const path = mediaQueuePath(statePath, course.key);
  const ownedPath = join(destination, "student.md");
  await writeFile(ownedPath, "Student-owned bytes");
  const notDirectory = join(root, "not-directory");
  await writeFile(notDirectory, "Retained regular file");
  const good = {
    recordingId: "synthetic",
    courseId: course.courseId,
    title: "Lecture",
    provider: "kaltura",
    providerReference: "entry:stable",
    placement: { destination: alias, statusPath: "Lecture.media-status.md" },
    attempts: 3,
  };
  for (const bad of [
    { ...good, courseId: "other-course" },
    { ...good, placement: { ...good.placement, destination: other } },
    { ...good, placement: { ...good.placement, destination: join(root, "missing") } },
    { ...good, placement: { ...good.placement, destination: notDirectory } },
    { ...good, placement: { destination: 42 } },
  ]) {
    const bytes = JSON.stringify({
      courseKey: course.key,
      courseId: course.courseId,
      queue: [bad],
    });
    await writeFile(path, bytes);
    await assert.rejects(
      readMediaQueue({ statePath, courseKey: course.key, course }),
      /review the course configuration/,
    );
    await assert.rejects(
      writeMediaQueue({ statePath, course, discovery: { complete: true, queue: [good] } }),
      /review the course configuration/,
    );
    await assert.rejects(
      updateMediaQueueJob({
        statePath,
        courseKey: course.key,
        course,
        recordingId: good.recordingId,
        update: { attempts: 4 },
      }),
      /review the course configuration/,
    );
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(await readFile(ownedPath, "utf8"), "Student-owned bytes");
  }
  await writeFile(
    path,
    JSON.stringify({ courseKey: course.key, courseId: course.courseId, queue: [good] }),
  );
  await assert.rejects(
    updateMediaQueueJob({
      statePath,
      courseKey: course.key,
      course,
      recordingId: good.recordingId,
      update: { attempts: 4 },
    }),
    /restore accessible course folders/,
  );
  await symlink(destination, alias);
  const recovered = await updateMediaQueueJob({
    statePath,
    courseKey: course.key,
    course,
    recordingId: good.recordingId,
    update: { attempts: 4 },
  });
  assert.equal(recovered.job.attempts, 4);
  assert.equal(recovered.job.placement.destination, alias);
  const priorBytes = await readFile(path, "utf8");
  for (const destination of [other, join(root, "missing"), notDirectory]) {
    await assert.rejects(
      writeMediaQueue({
        statePath,
        course,
        discovery: {
          complete: true,
          queue: [{ ...good, placement: { ...good.placement, destination } }],
        },
      }),
      /review the course configuration/,
    );
    assert.equal(await readFile(path, "utf8"), priorBytes);
  }
  assert.equal(await readFile(ownedPath, "utf8"), "Student-owned bytes");
});

test("distinct recorded aliases cannot bypass physical artifact placement collisions", async (t) => {
  const { mkdir, symlink, writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-queue-alias-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course");
  await mkdir(destination);
  const first = join(root, "alias-one");
  const second = join(root, "alias-two");
  await symlink(destination, first);
  await symlink(destination, second);
  const course = { ...COURSE, destination };
  const statePath = join(root, "state.json");
  const edited = join(destination, "Lecture.transcript.md");
  await writeFile(edited, "Student edited derivative");
  const queue = [first, second].map((path, index) => ({
    recordingId: `recording-${index}`,
    courseId: course.courseId,
    title: "Lecture",
    disposition: "recording",
    provider: "kaltura",
    providerReference: `entry:${index}`,
    placement: {
      destination: path,
      formattedTranscriptPath: "Lecture.transcript.md",
      statusPath: "Lecture.media-status.md",
    },
  }));
  const saved = await writeMediaQueue({ statePath, course, discovery: { complete: true, queue } });
  const retained = JSON.parse(await readFile(saved.path, "utf8")).queue;
  assert.deepEqual(
    retained.map((job) => job.placement.destination),
    [first, second],
  );
  assert.deepEqual(
    retained.map((job) => [job.stage, job.verdict, job.retryable]),
    [
      ["failed", "red", false],
      ["failed", "red", false],
    ],
  );
  assert.equal(await readFile(edited, "utf8"), "Student edited derivative");
});
