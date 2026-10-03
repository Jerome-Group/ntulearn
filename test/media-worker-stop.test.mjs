import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readMediaQueue, writeMediaQueue, updateMediaQueueJob } from "../src/media/queue.mjs";
import { capabilityIndex } from "../src/capabilities/index.mjs";
import { mediaRecordingRoot } from "../src/media/storage.mjs";
import { workerStopFailure, workerStopEvidence } from "../src/media/worker-stop.mjs";
import { runMediaQueue } from "../src/media/worker.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-worker-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json"),
    courses = ["fixture-a", "fixture-b"].map((key, index) => ({
      key,
      courseId: `fixture-course-${index}`,
      destination: join(root, key),
      mediaMode: "pilot",
    }));
  for (const course of courses)
    await writeMediaQueue({
      statePath,
      course,
      discovery: {
        complete: true,
        verdict: "green",
        queue: [
          {
            recordingId: "fixture-recording",
            provider: "direct",
            disposition: "recording",
            classificationEvidence: "media",
            placement: { destination: course.destination },
            limitations: ["Historical provider limitation."],
          },
        ],
      },
    });
  const run = (extra = {}) =>
    runMediaQueue({
      statePath,
      courses,
      mode: "manual",
      lock: null,
      preflight: async () => {},
      runJob: async () => assert.fail("no acquisition after fixture stop"),
      ...extra,
    });
  const log = async (digest) => JSON.parse(await readFile(join(root, digest.runLog), "utf8"));
  return { root, statePath, courses, run, log };
}

test("current queue-persistence stop survives historical limitations into course/run/digest", async (t) => {
  const f = await fixture(t);
  const error = Object.assign(
    new Error(`private detail ${f.root} https://example.invalid/source`),
    { code: "EIO" },
  );
  const digest = await f.run({
    updateJob: async () => {
      throw error;
    },
  });
  assert.equal(digest.globalStop, true);
  assert.equal(digest.verdict, "red");
  const expected = [{ code: "EIO", stage: "queue-active" }];
  assert.deepEqual(digest.stopFailures, expected);
  const run = await f.log(digest);
  assert.deepEqual(run.stopFailures, expected);
  assert.deepEqual(run.courses[0].stopFailures, expected);
  assert.equal(run.courses[0].limitation, "Historical provider limitation.");
  assert.equal(run.courses[1].stopFailures, undefined);
  assert.doesNotMatch(
    JSON.stringify(digest.stopFailures),
    /private detail|https:|fixture-course|ntulearn-worker-stop/,
  );
});

test("secondary red-status persistence retains primary stop and historical limitation", async (t) => {
  const f = await fixture(t);
  const gallery = join(f.courses[0].destination, "Media Gallery");
  await mkdir(gallery, { recursive: true });
  const digest = await f.run({
    updateJob: async () => {
      await rename(gallery, gallery + "-retained");
      await writeFile(gallery, "occupied fixture");
      throw injectedError("EIO");
    },
  });
  const run = await f.log(digest);
  assert.ok(["EEXIST", "ENOTDIR"].includes(digest.stopFailures?.[1]?.code));
  assert.deepEqual(digest.stopFailures, [
    { code: "EIO", stage: "queue-active" },
    { code: digest.stopFailures[1].code, stage: "course-status" },
  ]);
  assert.deepEqual(run.stopFailures, digest.stopFailures);
  assert.deepEqual(run.courses[0].stopFailures, digest.stopFailures);
  assert.equal(run.courses[0].limitation, "Historical provider limitation.");
  assert.equal(run.courses[1].stopFailures, undefined);
});

function injectedError(code) {
  return Object.assign(new Error("private fixture detail https://example.invalid/source"), {
    code,
  });
}
const incomplete = () => ({ complete: false, stage: "failed", verdict: "red", retryable: false });
const memoryUpdate = async ({ job, recordingId, update }) => ({
  job: { ...job, recordingId, ...update },
});

for (const stage of [
  "admission",
  "preflight",
  "queue-read",
  "queue-failure",
  "queue-result",
  "runner-settlement",
])
  test(`current ${stage} stop is closed and does not invent a failure on untouched courses`, async (t) => {
    const f = await fixture(t),
      error = injectedError("EIO");
    let reads = 0,
      jobs = 0;
    const extra = {
      runJob: async () => {
        jobs++;
        return incomplete();
      },
    };
    if (stage === "admission" || stage === "queue-read")
      extra.readQueue = async (options) => {
        reads++;
        if (reads === (stage === "admission" ? 1 : 3)) throw error;
        return readMediaQueue(options);
      };
    if (stage === "preflight")
      extra.preflight = async () => {
        throw error;
      };
    if (stage === "queue-failure" || stage === "queue-result") {
      if (stage === "queue-failure")
        extra.runJob = async () => {
          throw injectedError("PRIVATE_CODE");
        };
      extra.updateJob = async (options) => {
        if (options.update.stage !== "active") throw error;
        return updateMediaQueueJob(options);
      };
    }
    if (stage === "runner-settlement") {
      extra.runJob = async () => incomplete();
      extra.closeJobRunner = async () => {
        throw error;
      };
    }
    const digest = await f.run(extra),
      run = await f.log(digest);
    assert.equal(digest.globalStop, true);
    assert.deepEqual(digest.stopFailures, [
      { code: stage === "admission" ? "MEDIA_SAFETY_BARRIER" : "EIO", stage },
    ]);
    assert.deepEqual(run.stopFailures, digest.stopFailures);
    const courseScoped = ["queue-read", "queue-failure", "queue-result"].includes(stage);
    assert.deepEqual(run.courses[0].stopFailures, courseScoped ? digest.stopFailures : undefined);
    assert.equal(run.courses[1].stopFailures, undefined);
    assert.doesNotMatch(JSON.stringify(digest.stopFailures), /private|https:|fixture-course/);
    if (["admission", "preflight", "queue-read"].includes(stage)) assert.equal(jobs, 0);
  });

test("job cleanup, secondary failed persistence and runner settlement preserve their observed triggers and safety barrier", async (t) => {
  const f = await fixture(t);
  const digest = await f.run({
    runJob: async () => {
      throw injectedError("MEDIA_PROCESS_CLEANUP");
    },
    updateJob: async (options) => {
      if (options.update.stage !== "active") throw injectedError("ENOSPC");
      return updateMediaQueueJob(options);
    },
    closeJobRunner: async () => {
      throw injectedError("MEDIA_BROWSER_CLEANUP");
    },
  });
  assert.deepEqual(digest.stopFailures, [
    { code: "MEDIA_PROCESS_CLEANUP", stage: "job" },
    { code: "ENOSPC", stage: "queue-failure" },
    { code: "MEDIA_BROWSER_CLEANUP", stage: "runner-settlement" },
  ]);
  const run = await f.log(digest);
  assert.deepEqual(run.courses[0].stopFailures, digest.stopFailures.slice(0, 2));
  assert.equal(run.courses[1].stopFailures, undefined);
  const before = await readFile(join(f.root, "media-safety.json"));
  const next = await f.run();
  assert.deepEqual(next.stopFailures, [{ code: "MEDIA_SAFETY_BARRIER", stage: "admission" }]);
  assert.deepEqual(await readFile(join(f.root, "media-safety.json")), before);
});

test("capacity refusal keeps the capacity stage independent from the job stage", async (t) => {
  const f = await fixture(t);
  const digest = await f.run({
    checkCapacity: async () => {
      throw injectedError("ENOSPC");
    },
  });
  assert.deepEqual(digest.stopFailures, [{ code: "ENOSPC", stage: "capacity" }]);
  assert.equal((await f.log(digest)).courses[1].stopFailures, undefined);
});

for (const stage of ["course-status", "recording-status"])
  test(`actual ${stage} persistence failure survives the aggregate`, async (t) => {
    const f = await fixture(t);
    if (stage === "recording-status") {
      const loaded = await readMediaQueue({
        statePath: f.statePath,
        courseKey: f.courses[0].key,
        course: f.courses[0],
      });
      loaded.record.queue[0].placement.statusPath = "blocked/recording.md";
      await writeFile(loaded.path, JSON.stringify(loaded.record));
      await mkdir(join(f.courses[0].destination, "blocked"));
    }
    const digest = await f.run({
      updateJob: memoryUpdate,
      runJob: async () => {
        const blocked = join(
          f.courses[0].destination,
          stage === "course-status" ? "Media Gallery" : "blocked",
        );
        await rename(blocked, blocked + "-retained");
        await writeFile(blocked, "occupied fixture");
        return incomplete();
      },
    });
    assert.equal(digest.globalStop, true);
    assert.equal(digest.stopFailures[0].stage, stage);
    assert.ok(["EEXIST", "ENOTDIR"].includes(digest.stopFailures[0].code));
    assert.equal((await f.log(digest)).courses[1].stopFailures, undefined);
  });

test("unknown current cause remains unknown and an explicit later run does not inherit stop evidence", async (t) => {
  const f = await fixture(t);
  const digest = await f.run({
    updateJob: async () => {
      throw injectedError("PRIVATE_COURSE_ID");
    },
  });
  assert.deepEqual(digest.stopFailures, [{ code: "UNKNOWN", stage: "queue-active" }]);
  const retry = await f.run({ runJob: async () => incomplete() });
  assert.equal(retry.globalStop, false);
  assert.equal(retry.stopFailures, undefined);
  assert.equal(
    (await f.log(retry)).courses.some((c) => c.stopFailures),
    false,
  );
});

test("stop normalization is closed, bounded, nested-cause-aware and cycle safe", () => {
  const error = new Error("private text", { cause: injectedError("EIO") });
  assert.deepEqual(workerStopFailure(error, "job"), { code: "EIO", stage: "job" });
  error.cause = error;
  assert.deepEqual(workerStopFailure(error, "private stage"), {
    code: "UNKNOWN",
    stage: "unknown",
  });
  assert.deepEqual(workerStopFailure({ code: "PRIVATE_COURSE_ID", message: "secret" }, "job"), {
    code: "UNKNOWN",
    stage: "job",
  });
  assert.deepEqual(workerStopEvidence(), [{ code: "UNKNOWN", stage: "unknown" }]);
  assert.ok(
    workerStopEvidence(Array.from({ length: 100 }, () => ({ code: "EIO", stage: "job" }))).length <=
      17,
  );
});

for (const stage of ["queue-interruption", "queue-checkpoint"])
  test(`${stage} persistence failure retains the current trigger`, async (t) => {
    const f = await fixture(t),
      controller = new globalThis.AbortController();
    const digest = await f.run({
      signal: controller.signal,
      mode: stage === "queue-checkpoint" ? "scheduled" : "manual",
      timeZone: "UTC",
      now: () => new Date("2026-01-01T01:00:00Z"),
      runJob: async (_job, { requestCheckpoint }) => {
        if (stage === "queue-checkpoint") requestCheckpoint();
        else controller.abort(new Error("fixture caller interruption"));
        return incomplete();
      },
      updateJob: async (options) => {
        if (options.update.stage === "checkpointed") throw injectedError("EIO");
        return updateMediaQueueJob(options);
      },
    });
    assert.deepEqual(digest.stopFailures, [{ code: "EIO", stage }]);
    assert.equal((await f.log(digest)).courses[1].stopFailures, undefined);
  });

test("actual retained artifact read refusal is reported without weakening its verifier", async (t) => {
  const f = await fixture(t),
    mediaRoot = join(f.root, "media");
  const sourceRoot = mediaRecordingRoot(mediaRoot, "fixture-recording");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(sourceRoot, "transcript.raw.json"));
  const loaded = await readMediaQueue({
    statePath: f.statePath,
    courseKey: f.courses[0].key,
    course: f.courses[0],
  });
  Object.assign(loaded.record.queue[0], {
    complete: true,
    transcript: { complete: true },
    artifacts: { rawTranscript: join(sourceRoot, "transcript.raw.json") },
  });
  await writeFile(loaded.path, JSON.stringify(loaded.record));
  const digest = await f.run({ media: { mediaRoot }, checkCapacity: async () => {} });
  assert.equal(digest.globalStop, true);
  assert.deepEqual(digest.stopFailures, [{ code: "UNKNOWN", stage: "artifact-evidence" }]);
  assert.equal((await f.log(digest)).courses[1].stopFailures, undefined);
});

test("fixed capacity timeout and queue authority codes survive the closed contract", () => {
  for (const code of [
    "MEDIA_CAPACITY_TIMEOUT",
    "MEDIA_QUEUE_DESTINATION_UNVERIFIED",
    "MEDIA_SAFETY_BARRIER_WRITE",
  ])
    assert.deepEqual(workerStopFailure({ code }, "capacity"), { code, stage: "capacity" });
});

test("fresh machine route describes current stop fields and their bounded authority", () => {
  const feature = capabilityIndex("media-worker").features.find(({ id }) => id === "media-worker");
  assert.ok(feature.code.includes("src/media/worker-stop.mjs"));
  assert.ok(feature.verification.tests.includes("test/media-worker-stop.test.mjs"));
  assert.equal(feature.stopEvidence.field, "stopFailures");
  assert.deepEqual(feature.stopEvidence.fields, ["code", "stage"]);
  assert.ok(feature.stopEvidence.codes.includes("MEDIA_CAPACITY_TIMEOUT"));
  assert.ok(feature.stopEvidence.codes.includes("UNKNOWN"));
  assert.match(feature.stopEvidence.scope, /untouched|run-only/);
  assert.match(feature.stopEvidence.safety, /no release/);
});

test("actual capacity deadline preserves its fixed timeout code without claiming pending probe settlement", async (t) => {
  const f = await fixture(t);
  const digest = await f.run({
    checkCapacity: async () => new Promise(() => {}),
    capacityCheckTimeoutMs: 20,
  });
  assert.deepEqual(digest.stopFailures, [{ code: "MEDIA_CAPACITY_TIMEOUT", stage: "capacity" }]);
  assert.equal(digest.verdict, "red");
});

test("post-job artifact refusal retains current evidence before reporting any completion", async (t) => {
  const f = await fixture(t),
    mediaRoot = join(f.root, "media");
  const raw = join(mediaRecordingRoot(mediaRoot, "fixture-recording"), "transcript.raw.json");
  await mkdir(raw, { recursive: true });
  const digest = await f.run({
    media: { mediaRoot },
    checkCapacity: async () => {},
    runJob: async () => ({
      complete: true,
      transcript: { complete: true },
      artifacts: { rawTranscript: { path: raw } },
    }),
  });
  assert.equal(digest.globalStop, true);
  assert.deepEqual(digest.stopFailures, [{ code: "UNKNOWN", stage: "artifact-evidence" }]);
  assert.equal(digest.counts.completed, 0);
});

test("observed monitoring failure retains the capacity stage while a job is awaiting abort", async (t) => {
  const f = await fixture(t),
    error = injectedError("ENOSPC");
  let probes = 0;
  const digest = await f.run({
    capacityMonitorIntervalMs: 1,
    checkCapacity: async () => {
      if (++probes > 1) throw error;
    },
    runJob: async (_job, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  assert.ok(probes >= 2);
  assert.deepEqual(digest.stopFailures, [{ code: "ENOSPC", stage: "capacity" }]);
});
