import assert from "node:assert/strict";
import test from "node:test";
import { localStatus } from "../src/capabilities/status.mjs";
import { mediaQueuePath } from "../src/media/queue.mjs";
import { countQueue } from "../src/media/worker-report.mjs";

const now = () => new Date("2026-10-02T00:00:00.000Z");
const receipt = () => ({
  schemaVersion: 1,
  producer: "ntulearn",
  status: "complete",
  startedAt: "2026-10-01T00:00:00.000Z",
  finishedAt: "2026-10-01T00:01:00.000Z",
  lastSuccessfulAt: "2026-10-01T00:01:00.000Z",
  counts: { downloaded: 0, skipped: 1, markdown: 0, uncopied: 0, failures: 0 },
  unread: [],
});
const config = {
  statePath: "/private/fixture/state.json",
  courses: [
    { key: "PRIVATE", courseId: "_private_1", destination: "/private/course", mediaMode: "active" },
  ],
};

test("status separates missing, incomplete, ready declarations and stale evidence", async () => {
  let queue = {
    version: 1,
    courseKey: "PRIVATE",
    courseId: "_private_1",
    complete: true,
    verdict: "green",
    updatedAt: "2026-10-01T00:01:00.000Z",
    queue: [],
  };
  const read = async (path) => ({
    status: "passed",
    value: path.endsWith("Sync status.json")
      ? receipt()
      : path.includes("media-queue")
        ? queue
        : {
            verdict: "green",
            timestamp: "2026-10-01T00:01:00.000Z",
            message: "PRIVATE source lecture",
            runLog: "/private/log",
          },
  });
  const options = { root: "/private/root", now, load: async () => config, read };
  const ready = await localStatus(options);
  assert.equal(ready.status, "passed");
  assert.equal(ready.evidence.audioFidelity, "unrun");
  assert.ok(!JSON.stringify(ready).includes("PRIVATE"));
  assert.ok(!JSON.stringify(ready).includes("/private/"));
  queue = { ...queue, queue: [{ recordingId: "synthetic", stage: "checkpointed" }] };
  assert.equal((await localStatus(options)).status, "blocked");
  queue = { ...queue, complete: false, verdict: "red" };
  assert.equal((await localStatus(options)).status, "failed");
  queue = {
    ...queue,
    complete: true,
    verdict: "green",
    queue: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  assert.equal((await localStatus(options)).status, "blocked");
  assert.equal(
    (
      await localStatus({
        ...options,
        read: async () => ({ status: "blocked", code: "EVIDENCE_MISSING" }),
      })
    ).status,
    "blocked",
  );
});

test("status rejects mismatched course identities and future receipts", async () => {
  const result = await localStatus({
    root: "/fixture",
    now,
    load: async () => config,
    read: async (path) => ({
      status: "passed",
      value: path.endsWith("Sync status.json")
        ? { ...receipt(), startedAt: "2027-01-01T00:00:00.000Z" }
        : path.includes("media-queue")
          ? { version: 1, courseKey: "other", courseId: "_wrong", queue: [] }
          : { verdict: "green", timestamp: "2026-10-01T00:00:00.000Z" },
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((check) => check.id === "sync-receipts").evidence.invalid, 1);
  assert.equal(result.checks.find((check) => check.id === "media-queues").evidence.invalid, 1);
});

function statusFixture(courses, jobs, syncStatus = "complete") {
  return {
    root: "/private/root",
    now,
    load: async () => ({ ...config, courses }),
    read: async (path) => {
      const course = courses.find((item) => mediaQueuePath(config.statePath, item.key) === path);
      return {
        status: "passed",
        value: path.endsWith("Sync status.json")
          ? { ...receipt(), status: syncStatus }
          : course
            ? {
                version: 1,
                courseKey: course.key,
                courseId: course.courseId,
                complete: true,
                verdict: "green",
                updatedAt: "2026-10-01T00:01:00.000Z",
                queue: jobs[course.key] ?? [],
              }
            : { verdict: "green", timestamp: "2026-10-01T00:01:00.000Z" },
      };
    },
  };
}

test("empty and off media expose zero finite canonical counters", async () => {
  for (const mediaMode of ["active", "off"]) {
    const course = { ...config.courses[0], mediaMode };
    const result = await localStatus(statusFixture([course], {}));
    const media = result.checks.find((check) => check.id === "media-queues");
    assert.equal(media.status, mediaMode === "off" ? "unrun" : "passed");
    for (const key of Object.keys(countQueue([]))) {
      assert.equal(media.evidence[key], 0, key);
      assert.ok(Number.isFinite(media.evidence[key]), key);
      assert.equal(JSON.parse(JSON.stringify(media.evidence))[key], 0, key);
    }
  }
});

test("unresolved green declarations fail then recover without crediting exclusions", async () => {
  const course = config.courses[0];
  const jobs = {
    [course.key]: [
      { recordingId: "PRIVATE lecture", provider: "unsupported", stage: "failed", verdict: "red" },
    ],
  };
  const options = statusFixture([course], jobs);
  const failed = await localStatus(options);
  const media = failed.checks.find((check) => check.id === "media-queues");
  assert.equal(failed.exitCode, 1);
  assert.equal(media.status, "failed");
  assert.equal(media.evidence.unresolved, 1);
  assert.equal(media.evidence.failed, 0);
  assert.equal(media.code, "MEDIA_INCOMPLETE");
  assert.match(media.action, /inspect local media status/);
  assert.equal(failed.checks.find((check) => check.id === "sync-receipts").status, "passed");
  assert.equal(failed.checks.find((check) => check.id === "media-digest").status, "passed");
  assert.ok(!JSON.stringify(failed).includes("PRIVATE"));
  assert.ok(!JSON.stringify(failed).includes("/private/"));
  jobs[course.key] = [
    { ...jobs[course.key][0], disposition: "non-recording", classificationEvidence: "document" },
  ];
  const recovered = await localStatus(options);
  const recoveredMedia = recovered.checks.find((check) => check.id === "media-queues");
  assert.equal(recovered.exitCode, 0);
  assert.equal(recoveredMedia.evidence.excluded, 1);
  assert.equal(recoveredMedia.evidence.completed, 0);
  assert.equal(recoveredMedia.evidence.unresolved, 0);
  assert.match(recoveredMedia.message, /Queue declarations only/);
  assert.equal(recovered.evidence.audioFidelity, "unrun");
  const syncFailed = await localStatus(statusFixture([course], jobs, "failed"));
  assert.equal(syncFailed.exitCode, 1);
  assert.equal(syncFailed.checks.find((check) => check.id === "media-queues").status, "passed");
  assert.equal(syncFailed.checks.find((check) => check.id === "sync-receipts").status, "failed");
});

test("multiple courses aggregate lifecycle and disposition counters independently", async () => {
  const courses = [
    config.courses[0],
    {
      ...config.courses[0],
      key: "PRIVATE2",
      courseId: "_private_2",
      destination: "/private/second",
    },
    { ...config.courses[0], key: "OFF", mediaMode: "off" },
  ];
  const jobs = {
    PRIVATE: [
      { recordingId: "queued" },
      { recordingId: "active", stage: "active" },
      { recordingId: "checkpoint", stage: "checkpointed" },
      { recordingId: "failed", stage: "failed" },
    ],
    PRIVATE2: [
      { recordingId: "document", disposition: "non-recording", classificationEvidence: "document" },
      { recordingId: "unknown", provider: "unsupported" },
      { recordingId: "withdrawn", provider: "unsupported", stage: "withdrawn" },
      { recordingId: "completed", complete: true, transcript: { complete: true } },
    ],
    OFF: [{ recordingId: "ignored", provider: "unsupported" }],
  };
  const original = JSON.stringify({ courses, jobs });
  const result = await localStatus(statusFixture(courses, jobs));
  assert.equal(JSON.stringify({ courses, jobs }), original);
  const media = result.checks.find((check) => check.id === "media-queues");
  assert.equal(media.evidence.enabled, 2);
  assert.equal(media.evidence.total, 8);
  assert.deepEqual(
    Object.fromEntries(Object.keys(countQueue([])).map((key) => [key, media.evidence[key]])),
    {
      excluded: 1,
      unresolved: 1,
      queued: 1,
      active: 1,
      checkpointed: 1,
      completed: 1,
      failed: 1,
      withdrawn: 1,
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((check) => check.id === "sync-receipts").evidence.complete, 3);
});
