import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { readMediaQueue, writeMediaQueue } from "../src/media/queue.mjs";
import {
  isOvernightWindow,
  mediaDigestPaths,
  mediaWorkerExitCode,
  runMediaQueue,
} from "../src/media/worker.mjs";

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
      return completeResult({ artifacts: {} });
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

test("updates the course and recording status documents from worker results", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-status-"));
  const statePath = join(root, "state.json");
  const course = {
    ...COURSE,
    destination: join(root, "course"),
  };
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
  await writeMediaQueue({
    statePath,
    course,
    discovery: { complete: true, verdict: "green", queue: [appearance] },
  });

  const digest = await runQueue({
    statePath,
    courses: [course],
    mode: "manual",
    async runJob() {
      return {
        complete: true,
        stage: "complete",
        verdict: "green",
        transcript: { complete: true, sourceKind: "provider", language: "en-SG" },
        duration: 10,
        speechDuration: 9,
        media: {
          video: { available: true, quality: 720, audio: true },
          audio: { available: true, quality: null, audio: true },
        },
      };
    },
  });

  assert.equal(digest.verdict, "green");
  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /Verdict: green/,
  );
  assert.match(
    await readFile(join(course.destination, "Media Gallery/Week 1.media-status.md"), "utf8"),
    /Stage: complete/,
  );
  assert.match(
    await readFile(join(course.destination, "Media Gallery/Week 1.media-status.md"), "utf8"),
    /Duration: 10\.0s/,
  );
  assert.match(
    await readFile(join(course.destination, "Media Gallery/Week 1.media-status.md"), "utf8"),
    /Speech duration: 9\.0s/,
  );
});

test("does not accept a green worker result without a complete transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-transcript-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["lecture-1"]);

  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob() {
      return {
        complete: true,
        stage: "complete",
        verdict: "green",
        transcript: { complete: false },
      };
    },
  });

  assert.equal(digest.verdict, "red");
  assert.equal(digest.counts.failed, 1);
});

test("retries a durable complete flag whose transcript is incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-strict-complete-"));
  const statePath = join(root, "state.json");
  await writeMediaQueue({
    statePath,
    course: COURSE,
    discovery: {
      complete: true,
      queue: [
        {
          recordingId: "legacy-complete",
          complete: true,
          stage: "complete",
          verdict: "green",
          transcript: { complete: false },
        },
      ],
    },
  });
  let attempts = 0;

  const digest = await runQueue({
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob() {
      attempts += 1;
      return completeResult();
    },
  });

  assert.equal(attempts, 1);
  assert.equal(digest.counts.completed, 1);
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
      return completeResult();
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
      return completeResult();
    },
  });

  assert.equal(attempted, 1);
  assert.equal(manual.verdict, "green");
});

test("keeps work pending before its eligible window and turns an incomplete attempt red", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-window-"));
  const statePath = join(root, "state.json");
  const course = { ...COURSE, destination: join(root, "course") };
  const appearance = {
    recordingId: "media-gallery:_9_1:window-1",
    title: "Windowed lecture",
    provider: "kaltura",
    sourceKind: "media-gallery",
    placement: {
      destination: course.destination,
      statusPath: "Media Gallery/Windowed lecture.media-status.md",
    },
  };
  await writeMediaQueue({
    statePath,
    course,
    discovery: { complete: true, verdict: "green", queue: [appearance] },
  });

  const beforeWindow = await runQueue({
    statePath,
    courses: [course],
    timeZone: "Asia/Singapore",
    now: () => new Date("2026-08-16T05:00:00+08:00"),
    async runJob() {
      throw new Error("scheduled work must wait outside the window");
    },
  });
  assert.equal(beforeWindow.verdict, "yellow");
  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /Verdict: yellow/,
  );

  const afterWindow = await runQueue({
    statePath,
    courses: [course],
    timeZone: "Asia/Singapore",
    now: () => new Date("2026-08-17T01:00:00+08:00"),
    async runJob() {
      return {
        complete: false,
        stage: "pending",
        verdict: "red",
        retryable: true,
        limitations: ["Formatted transcript is still missing."],
      };
    },
  });
  assert.equal(afterWindow.verdict, "red");
  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /Verdict: red/,
  );
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
      return completeResult();
    },
  });

  assert.equal(resumed.verdict, "green");
  assert.equal(resumed.counts.completed, 2);
});

test("keeps untouched courses in the aggregate after an overnight checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-aggregate-stop-"));
  const statePath = join(root, "state.json");
  const secondCourse = { ...COURSE, key: "MH2100", courseId: "_9_2" };
  await writeQueue(statePath, COURSE, ["lecture-1"]);
  await writeQueue(statePath, secondCourse, ["lecture-2"]);
  let current = new Date("2026-08-16T03:59:00+08:00");

  const digest = await runQueue({
    statePath,
    courses: [COURSE, secondCourse],
    timeZone: "Asia/Singapore",
    now: () => current,
    schedule(callback) {
      return callback;
    },
    cancelSchedule() {},
    async runJob(_job, { requestCheckpoint }) {
      current = new Date("2026-08-16T04:00:00+08:00");
      requestCheckpoint();
      return { complete: false };
    },
  });
  const run = JSON.parse(await readFile(join(root, digest.runLog), "utf8"));

  assert.equal(run.courses.length, 2);
  assert.equal(run.counts.total, 2);
  assert.equal(run.counts.checkpointed, 1);
  assert.equal(run.counts.queued, 1);
});

test("keeps every enabled course in a failed preflight aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-preflight-aggregate-"));
  const statePath = join(root, "state.json");
  const secondCourse = { ...COURSE, key: "MH2100", courseId: "_9_2" };
  await writeQueue(statePath, COURSE, ["lecture-1"]);
  await writeQueue(statePath, secondCourse, ["lecture-2"]);

  const digest = await runMediaQueue({
    statePath,
    courses: [COURSE, secondCourse],
    mode: "manual",
    lock: null,
    async preflight() {
      throw new Error("Runtime verification failed. Run: npm run media:setup");
    },
    async runJob() {
      throw new Error("preflight must stop jobs");
    },
  });
  const run = JSON.parse(await readFile(join(root, digest.runLog), "utf8"));

  assert.equal(run.courses.length, 2);
  assert.equal(run.counts.total, 2);
  assert.equal(run.counts.queued, 2);
  assert.equal(digest.verdict, "red");
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
      return completeResult();
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
      return completeResult();
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
      return completeResult();
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

test("writes a red course status when the media-store preflight fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-safety-status-"));
  const statePath = join(root, "state.json");
  const course = { ...COURSE, destination: join(root, "course") };
  await writeQueue(statePath, course, ["lecture-1"]);

  await runQueue({
    statePath,
    courses: [course],
    mode: "manual",
    async preflight() {
      const error = new Error("Media store is unavailable; mount RAID0.");
      error.globalSafety = true;
      throw error;
    },
    async runJob() {
      throw new Error("preflight must stop the queue");
    },
  });

  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /mount RAID0/,
  );
});

test("writes red status and retry history when a running job hits global safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-safety-job-status-"));
  const statePath = join(root, "state.json");
  const course = { ...COURSE, destination: join(root, "course") };
  const appearance = {
    recordingId: "media-gallery:_9_1:safety-1",
    title: "Safety lecture",
    provider: "kaltura",
    sourceKind: "media-gallery",
    placement: {
      destination: course.destination,
      statusPath: "Media Gallery/Safety lecture.media-status.md",
    },
  };
  await writeMediaQueue({
    statePath,
    course,
    discovery: { complete: true, verdict: "green", queue: [appearance] },
  });

  const digest = await runQueue({
    statePath,
    courses: [course],
    mode: "manual",
    async runJob() {
      const error = new Error("Media store disappeared during acquisition.");
      error.globalSafety = true;
      throw error;
    },
  });

  assert.equal(digest.verdict, "red");
  assert.equal(digest.globalStop, true);
  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /Media store disappeared/,
  );
  assert.match(
    await readFile(join(course.destination, appearance.placement.statusPath), "utf8"),
    /Stage: failed/,
  );
  const job = (await readMediaQueue({ statePath, courseKey: course.key })).record.queue[0];
  assert.equal(job.retryable, true);
  assert.match(job.lastError, /Media store disappeared/);
});

test("writes red course status when the durable queue cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-queue-status-"));
  const statePath = join(root, "state.json");
  const course = { ...COURSE, destination: join(root, "course") };

  const digest = await runQueue({
    statePath,
    courses: [course],
    mode: "manual",
    readQueue: async () => {
      throw new Error("queue state is unreadable");
    },
    async runJob() {
      throw new Error("queue read must stop before a job");
    },
  });

  assert.equal(digest.verdict, "red");
  assert.match(
    await readFile(join(course.destination, "Media Gallery/media-status.md"), "utf8"),
    /queue state is unreadable/,
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

test("keeps an explicit terminal failure red without retrying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-worker-terminal-"));
  const statePath = join(root, "state.json");
  await writeQueue(statePath, COURSE, ["unsupported-1"]);
  let attempts = 0;
  const options = {
    statePath,
    courses: [COURSE],
    mode: "manual",
    async runJob() {
      attempts += 1;
      return {
        complete: false,
        stage: "failed",
        verdict: "red",
        retryable: false,
        limitations: ["Unsupported recording provider shape."],
      };
    },
  };

  assert.equal((await runQueue(options)).verdict, "red");
  assert.equal((await runQueue(options)).verdict, "red");
  assert.equal(attempts, 1);
});

test("maps every non-green aggregate verdict to a failing process exit", () => {
  assert.equal(mediaWorkerExitCode({ verdict: "green" }), 0);
  assert.equal(mediaWorkerExitCode({ verdict: "yellow" }), 1);
  assert.equal(mediaWorkerExitCode({ verdict: "red" }), 1);
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

function completeResult(extra = {}) {
  return {
    complete: true,
    stage: "complete",
    verdict: "green",
    transcript: { complete: true, sourceKind: "provider", language: "en-SG" },
    ...extra,
  };
}
