import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { readMediaQueue, writeMediaQueue } from "../src/media/queue.mjs";
import { isOvernightWindow, mediaDigestPaths, runMediaQueue } from "../src/media/worker.mjs";

const COURSE = { key: "MH1101", courseId: "_9_1", mediaMode: "pilot" };

test("processes every enabled queue one appearance at a time and writes an independent digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  const secondCourse = { ...COURSE, key: "MH2100", courseId: "_9_2" };
  await writeQueue(statePath, COURSE, ["kaltura-1", "youtube-1"]);
  await writeQueue(statePath, secondCourse, ["direct-1"]);

  const events = [];
  let active = 0;
  let maximumActive = 0;
  const digest = await runQueue({
    statePath,
    courses: [COURSE, secondCourse],
    mode: "manual",
    async runJob(job) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      events.push(`start:${job.recordingId}`);
      await Promise.resolve();
      events.push(`end:${job.recordingId}`);
      active -= 1;
      return { complete: true, stage: "complete", verdict: "green", artifacts: {} };
    },
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(events, [
    "start:kaltura-1",
    "end:kaltura-1",
    "start:youtube-1",
    "end:youtube-1",
    "start:direct-1",
    "end:direct-1",
  ]);
  assert.equal(digest.verdict, "green");
  assert.equal(digest.counts.completed, 3);
  assert.equal(digest.counts.failed, 0);
  assert.match(digest.runLog, /^media-logs\/.+\.json$/);

  const latest = JSON.parse(await readFile(mediaDigestPaths(statePath).latestPath, "utf8"));
  assert.equal(latest.verdict, "green");
  assert.equal(latest.runLog, digest.runLog);
  assert.equal(
    (await readMediaQueue({ statePath, courseKey: COURSE.key })).record.queue[0].complete,
    true,
  );
});

test("scheduled work does not start outside the overnight window, while manual work bypasses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1"]);
  let attempted = 0;

  const scheduled = await runQueue({
    statePath,
    courses: [COURSE],
    now: () => new Date("2026-08-16T05:00:00+08:00"),
    async runJob() {
      attempted += 1;
      return { complete: true };
    },
  });

  assert.equal(attempted, 0);
  assert.equal(scheduled.verdict, "yellow");
  assert.match(scheduled.message, /outside the overnight window/i);

  const manual = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    now: () => new Date("2026-08-16T12:00:00+08:00"),
    async runJob() {
      attempted += 1;
      return { complete: true };
    },
  });

  assert.equal(attempted, 1);
  assert.equal(manual.verdict, "green");
});

test("stops the current job at 04:00 and leaves a checkpoint that a later run resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1", "lecture-2"]);
  let current = new Date("2026-08-16T03:59:00+08:00");
  let boundary;
  let released;
  let signalAborted = false;
  const clock = {
    now: () => current,
    setTimeout(callback) {
      boundary = callback;
      return "timer";
    },
    clearTimeout() {},
  };
  const scheduled = runQueue({
    statePath,
    courses: [COURSE],
    clock,
    timeZone: "Asia/Singapore",
    async runJob(job, { signal }) {
      assert.equal(job.recordingId, "lecture-1");
      signal.addEventListener("abort", () => {
        signalAborted = true;
      });
      await new Promise((resolve) => {
        released = () => {
          current = new Date("2026-08-16T04:00:00+08:00");
          boundary();
          resolve();
        };
      });
      return { complete: false, stage: "red", verdict: "red", retryable: true };
    },
  });

  while (!released) await setImmediate();
  released();
  const checkpointed = await scheduled;
  const queueAfterStop = (await readMediaQueue({ statePath, courseKey: COURSE.key })).record.queue;

  assert.equal(signalAborted, true);
  assert.equal(checkpointed.verdict, "yellow");
  assert.equal(checkpointed.counts.checkpointed, 1);
  assert.equal(checkpointed.counts.queued, 1);
  assert.equal(queueAfterStop[0].stage, "checkpointed");
  assert.equal(queueAfterStop[0].complete, false);
  assert.equal(queueAfterStop[1].stage, undefined);

  const resumed = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    now: () => new Date("2026-08-16T12:00:00+08:00"),
    async runJob(job) {
      assert.match(job.recordingId, /^lecture-[12]$/);
      return { complete: true, stage: "complete", verdict: "green" };
    },
  });

  assert.equal(resumed.verdict, "green");
  assert.equal(resumed.counts.completed, 2);
});

test("keeps recording failures retryable while continuing with later appearances", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["failed-1", "complete-1", "complete-2"]);
  const attempted = [];

  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob(job) {
      attempted.push(job.recordingId);
      if (job.recordingId === "failed-1") throw new Error("provider unavailable");
      return { complete: true, stage: "complete", verdict: "green" };
    },
  });
  const queue = (await readMediaQueue({ statePath, courseKey: COURSE.key })).record.queue;

  assert.deepEqual(attempted, ["failed-1", "complete-1", "complete-2"]);
  assert.equal(digest.verdict, "red");
  assert.equal(digest.counts.failed, 1);
  assert.equal(queue[0].stage, "failed");
  assert.equal(queue[0].retryable, true);
  assert.match(queue[0].limitation, /provider unavailable/);
  assert.equal(queue[1].complete, true);
  assert.equal(queue[2].complete, true);
});

test("skips a completed appearance and never persists an execution-time provider URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1"]);
  let attempts = 0;

  await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob(job) {
      attempts += 1;
      job.resolvedUrl = "https://provider.example.test/expiring?token=secret";
      return { complete: true, stage: "complete", verdict: "green" };
    },
  });

  const second = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob() {
      throw new Error("a completed appearance must not run again");
    },
  });
  const queueContent = await readFile(
    (await readMediaQueue({ statePath, courseKey: COURSE.key })).path,
    "utf8",
  );

  assert.equal(attempts, 1);
  assert.equal(second.verdict, "green");
  assert.doesNotMatch(queueContent, /expiring|secret|resolvedUrl/);
});

test("stops before any job on a global media-store safety failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1", "lecture-2"]);
  let attempted = 0;

  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async preflight() {
      const error = new Error("Media store is unavailable; mount RAID0.");
      error.globalSafety = true;
      throw error;
    },
    async runJob() {
      attempted += 1;
      return { complete: true };
    },
  });

  assert.equal(attempted, 0);
  assert.equal(digest.verdict, "red");
  assert.equal(digest.globalStop, true);
  assert.match(digest.message, /mount RAID0/);
  assert.equal(
    (await readMediaQueue({ statePath, courseKey: COURSE.key })).record.queue[0].complete,
    undefined,
  );
});

test("keeps a global safety failure red when it coincides with the cutoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1"]);
  let current = new Date("2026-08-16T03:59:00+08:00");
  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    timeZone: "Asia/Singapore",
    now: () => current,
    schedule(callback) {
      return callback;
    },
    cancelSchedule() {},
    async runJob(_job, { requestCheckpoint }) {
      current = new Date("2026-08-16T04:00:00+08:00");
      requestCheckpoint();
      const error = new Error("Media store disappeared");
      error.globalSafety = true;
      throw error;
    },
  });

  assert.equal(digest.verdict, "red");
  assert.equal(digest.globalStop, true);
});

test("defines the four-hour boundary as 00:00 inclusive and 04:00 exclusive", () => {
  const timeZone = "Asia/Singapore";
  assert.equal(isOvernightWindow(new Date("2026-08-16T00:00:00+08:00"), timeZone), true);
  assert.equal(isOvernightWindow(new Date("2026-08-16T03:59:59+08:00"), timeZone), true);
  assert.equal(isOvernightWindow(new Date("2026-08-16T04:00:00+08:00"), timeZone), false);
  assert.equal(isOvernightWindow(new Date("2026-08-16T23:59:59+08:00"), timeZone), false);
});

test("requires an explicit media runtime safety preflight", async () => {
  await assert.rejects(
    runMediaQueue({
      statePath: "/tmp/ntulearn-media-state.json",
      courses: [],
      mode: "manual",
      runJob: async () => ({ complete: true }),
      lock: null,
    }),
    /media runtime preflight/,
  );
});

test("records an overlapping run without starting another provider job", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-"));
  const statePath = join(root, "state.json");
  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    lock: async () => {
      const error = new Error("another run is active");
      error.code = "MEDIA_QUEUE_LOCK_HELD";
      throw error;
    },
    async runJob() {
      throw new Error("the overlapping run must not start a job");
    },
  });

  assert.equal(digest.verdict, "yellow");
  assert.match(digest.message, /another run is active/i);
});

async function writeQueue(statePath, course, recordingIds) {
  await writeMediaQueue({
    statePath,
    course,
    discovery: {
      complete: true,
      verdict: "green",
      queue: recordingIds.map((recordingId) => ({
        recordingId,
        provider: recordingId.split("-")[0],
      })),
    },
  });
}

function runQueue(options) {
  return runMediaQueue({ preflight: async () => {}, ...options });
}
