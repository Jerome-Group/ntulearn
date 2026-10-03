import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeVerification } from "../src/media/runtime-verification.mjs";
import { runProductionMedia } from "../src/media/production.mjs";
import { readMediaQueue, writeMediaQueue } from "../src/media/queue.mjs";
import { runMediaJob } from "../src/media/job.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";

test("runs all enabled courses and providers under one aggregate digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-production-"));
  const statePath = join(root, "state.json");
  const courses = [course("AB1001"), course("AB1002")].map((entry) => ({
    ...entry,
    destination: join(root, entry.key),
  }));
  const mediaRoot = join(root, "media");
  await queue(statePath, courses[0], "kaltura", "entry-1");
  await queue(statePath, courses[1], "youtube", "video-1");
  let preflights = 0;
  let capacityChecks = 0;
  let closes = 0;

  const signalProcessGroup = () => false;
  const options = {
    signalProcessGroup,
    config: { statePath, courses, media: { mediaRoot } },
    mode: "manual",
    createCapacity: async () => ({
      check: async () => {},
      checkJob: async () => {
        capacityChecks += 1;
      },
    }),
    verifyRuntime: async (_media, composition) => {
      assert.equal(composition.signalProcessGroup, signalProcessGroup);
      preflights += 1;
      return { runtime: {} };
    },
    createJobRunner: async (composition) => {
      assert.equal(composition.signalProcessGroup, signalProcessGroup);
      return {
        run: async (appearance) => completeResult({ appearance, mediaRoot, volumeRoot: root }),
        close: async () => {
          closes += 1;
        },
      };
    },
    lock: null,
  };
  const result = await runProductionMedia(options);

  assert.equal(result.digest.verdict, "green");
  assert.equal(result.digest.counts.completed, 2);
  assert.equal(result.digest.counts.total, 2);
  assert.equal(result.exitCode, 0);
  assert.equal(preflights, 1);
  assert.ok(capacityChecks >= 2);
  assert.equal(closes, 1);
  const held = (await readMediaQueue({ statePath, courseKey: courses[0].key, course: courses[0] }))
    .record.queue[0];
  assert.match(held.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(held.formattedSha256, /^[0-9a-f]{64}$/);
  const rawBefore = await readFile(held.artifacts.rawTranscript, "utf8");
  await unlink(held.artifacts.formattedTranscript);
  const repaired = await runProductionMedia(options);
  assert.equal(repaired.digest.verdict, "green");
  assert.equal(repaired.digest.counts.processed, 1);
  assert.equal(await readFile(held.artifacts.rawTranscript, "utf8"), rawBefore);
  await writeFile(held.artifacts.formattedTranscript, "student annotation");
  const edited = await runProductionMedia(options);
  assert.equal(edited.digest.verdict, "red");
  assert.equal(edited.exitCode, 1);
  assert.equal(await readFile(held.artifacts.formattedTranscript, "utf8"), "student annotation");
});

test("turns positively identified unsupported recordings into terminal red failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-production-unsupported-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001", "pilot"), destination: join(root, "course") };
  await queue(statePath, selected, "unsupported", "opaque-1");
  let composed = false;
  const options = {
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
    createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
    verifyRuntime: async () => ({ runtime: {} }),
    createJobRunner: async () => {
      composed = true;
      throw new Error("unsupported work needs no provider composition");
    },
    lock: null,
  };

  const first = await runProductionMedia(options);
  const second = await runProductionMedia(options);
  const job = (await readMediaQueue({ statePath, courseKey: selected.key })).record.queue[0];

  assert.equal(first.digest.verdict, "red");
  assert.equal(second.digest.counts.processed, 0);
  assert.equal(first.exitCode, 1);
  assert.equal(job.stage, "failed");
  assert.equal(job.retryable, false);
  assert.equal(composed, false);
});

test("returns green without runtime or browser work when no media course is enabled", async () => {
  let touchedRuntime = false;
  const result = await runProductionMedia({
    config: { statePath: "/tmp/state.json", courses: [course("AB1001", "off")], media: null },
    mode: "manual",
    createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
    verifyRuntime: async () => {
      touchedRuntime = true;
    },
    createJobRunner: async () => {
      throw new Error("no job runner needed");
    },
    lock: null,
    write: async () => {},
  });

  assert.equal(result.digest.verdict, "green");
  assert.equal(result.digest.counts.total, 0);
  assert.equal(touchedRuntime, false);
});

function course(key, mediaMode = "active") {
  return { key, courseId: `_${key}_1`, destination: "/tmp/course", mediaMode };
}

async function queue(statePath, selectedCourse, provider, recordingId) {
  await writeMediaQueue({
    statePath,
    course: selectedCourse,
    discovery: {
      complete: true,
      verdict: "green",
      queue: [
        {
          recordingId,
          provider,
          disposition: "recording",
          classificationEvidence: "media",
          placement: {
            destination: selectedCourse.destination,
            videoPath: `${recordingId}.mp4`,
            audioPath: `${recordingId}.m4a`,
            formattedTranscriptPath: `${recordingId}.transcript.md`,
            statusPath: `${recordingId}.media-status.md`,
          },
        },
      ],
    },
  });
}

async function completeResult({ appearance, mediaRoot, volumeRoot }) {
  const text = "This is a complete fixture transcript.";
  return runMediaJob({
    appearance,
    storage: createMediaStorage({ mediaRoot, volumeRoot }),
    provider: {
      name: appearance.provider,
      resolve: async () => ({ duration: 1 }),
      transcript: async () => ({
        filename: "captions.json",
        body: JSON.stringify({ language: "en", segments: [{ start: 0, end: 1, text }] }),
      }),
      media: async () => ({ kind: "video", body: Buffer.from("fixture media"), audio: true }),
    },
    formatter: { version: "fixture-1", format: async () => text },
  });
}

test("expired mandatory verification publishes global red and never composes acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-preflight-deadline-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001"), destination: join(root, "course") };
  await queue(statePath, selected, "youtube", "fixture");
  let acquisitions = 0;
  let stalled = true;
  const options = {
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
    lock: null,
    createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
    verifyRuntime: async () => {
      const verification = createRuntimeVerification({}, { verificationTimeoutMs: 20 });
      await verification.read(() => (stalled ? new Promise(() => {}) : Promise.resolve()));
      return { runtime: {} };
    },
    createJobRunner: async () => {
      acquisitions += 1;
      return {
        run: async () => {
          throw new Error("fixture acquisition reached after responsive retry");
        },
      };
    },
  };
  const before = (await readMediaQueue({ statePath, courseKey: selected.key })).record.queue[0];
  const stopped = await runProductionMedia(options);
  assert.equal(stopped.digest.verdict, "red");
  assert.equal(stopped.exitCode, 1);
  assert.equal(acquisitions, 0);
  const held = (await readMediaQueue({ statePath, courseKey: selected.key })).record.queue[0];
  assert.deepEqual(held, before);
  stalled = false;
  await runProductionMedia(options);
  assert.equal(acquisitions, 1);
});

test("keeps full startup verification mandatory when capacity initialization stalls", async () => {
  let runtimeVerifications = 0;
  const result = await Promise.race([
    runProductionMedia({
      config: {
        statePath: "/unused/synthetic-state.json",
        courses: [course("SYNTHETIC")],
        media: {},
      },
      mode: "manual",
      lock: null,
      write: async () => {},
      readQueue: async () => null,
      verifyRuntime: async () => {
        runtimeVerifications += 1;
        return { runtime: {} };
      },
      createCapacity: () => new Promise(() => {}),
      capacityCheckTimeoutMs: 10,
      createJobRunner: async () => assert.fail("capacity initialization must prevent acquisition"),
    }),
    new Promise((_, reject) =>
      globalThis.setTimeout(() => reject(new Error("fixture exceeded bound")), 150),
    ),
  ]);
  assert.equal(runtimeVerifications, 1);
  assert.equal(result.digest.globalStop, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.digest.message, /timed out.*retry/);
});

test("cancellation during preflight settles verification and prevents acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-production-cancel-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001"), destination: join(root, "course") };
  await queue(statePath, selected, "youtube", "fixture");
  const controller = new globalThis.AbortController();
  const reason = new Error("Synthetic preflight interruption; retry later.");
  let settled = false;
  const result = await runProductionMedia({
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
    lock: null,
    signal: controller.signal,
    verifyRuntime: async (_media, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort(reason);
      await Promise.resolve();
      settled = true;
      return { runtime: {} };
    },
    createCapacity: async () => assert.fail("no capacity initialization after cancellation"),
    createJobRunner: async () => assert.fail("no acquisition after cancellation"),
  });
  assert.equal(settled, true);
  assert.equal(controller.signal.reason, reason);
  assert.equal(result.digest.interrupted, true);
  assert.equal(result.digest.globalStop, false);
  assert.equal(result.digest.counts.total, 1);
  assert.equal(result.digest.counts.queued, 1);
  assert.equal(result.digest.verdict, "yellow");
  assert.equal(result.exitCode, 1);
});

test("production cancellation waits for runner close before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-production-close-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001"), destination: join(root, "course") };
  await queue(statePath, selected, "youtube", "fixture");
  const controller = new globalThis.AbortController();
  const reason = new Error("Synthetic job interruption; retry later.");
  let closed = false;
  const result = await runProductionMedia({
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
    lock: null,
    signal: controller.signal,
    verifyRuntime: async () => ({ runtime: {} }),
    createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
    createJobRunner: async () => ({
      async run(_appearance, { signal }) {
        controller.abort(reason);
        assert.equal(signal.reason, reason);
        throw reason;
      },
      async close() {
        await Promise.resolve();
        closed = true;
      },
    }),
  });
  assert.equal(closed, true);
  assert.equal(result.digest.interrupted, true);
  assert.equal(result.digest.counts.checkpointed, 1);
});

test("production retains queue ownership through browser settlement and marks cleanup uncertainty red", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-production-settlement-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001"), destination: join(root, "course") };
  await queue(statePath, selected, "youtube", "fixture");
  let held = false;
  await assert.rejects(
    runProductionMedia({
      config: { statePath, courses: [selected], media: {} },
      mode: "manual",
      lock: async ({ run }) => {
        held = true;
        try {
          return await run();
        } finally {
          held = false;
        }
      },
      verifyRuntime: async () => ({ runtime: {} }),
      createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
      createJobRunner: async () => ({
        async run() {
          return { complete: false };
        },
        async close() {
          assert.equal(held, true);
          throw new Error("Synthetic browser cleanup uncertainty; inspect owned session.");
        },
      }),
    }),
    /cleanup/,
  );
  assert.equal(held, false);
  const digest = JSON.parse(await readFile(join(root, "media-latest.json"), "utf8"));
  assert.equal(digest.globalStop, true);
  assert.equal(digest.verdict, "red");
  const barrier = JSON.parse(await readFile(join(root, "media-safety.json"), "utf8"));
  assert.equal(barrier.code, "MEDIA_BROWSER_CLEANUP");
  const blocked = await runProductionMedia({
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
    lock: null,
    verifyRuntime: async () => assert.fail("browser-uncertain restart must refuse preflight"),
    createJobRunner: async () => assert.fail("no browser admission after uncertain close"),
  });
  assert.equal(blocked.digest.globalStop, true);
  assert.equal(blocked.exitCode, 1);
});

test("startup abort plus browser-close uncertainty before runner assignment stops all queues with a durable barrier", async (t) => {
  const { chromium } = await import("playwright");
  const { openClient } = await import("../src/ntulearn/client.mjs");
  const { mkdir, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-production-startup-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json"),
    selected = [course("AB1001"), course("AB1002")].map((c) => ({
      ...c,
      destination: join(root, c.key),
    }));
  for (const c of selected) {
    await mkdir(c.destination);
    await queue(statePath, c, "direct", "fixture");
  }
  const secondBefore = (await readMediaQueue({ statePath, courseKey: selected[1].key })).record
    .queue[0];
  const controller = new globalThis.AbortController();
  let launches = 0;
  t.mock.method(chromium, "launchPersistentContext", async () => {
    launches++;
    return {
      pages: () => [
        {
          on: () => {},
          goto: async () => {
            controller.abort(new Error("Owned fixture startup interruption"));
            throw new Error("Owned fixture sign-in failure");
          },
        },
      ],
      close: async () => {
        throw new Error("Owned fixture startup close uncertainty");
      },
    };
  });
  const result = await runProductionMedia({
    config: {
      statePath,
      profilePath: join(root, "empty-owned-profile"),
      courses: selected,
      media: { mediaRoot: join(root, "media") },
    },
    mode: "manual",
    signal: controller.signal,
    verifyRuntime: async () => ({ runtime: {} }),
    createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
    createJobRunner: async ({ config }) => {
      await openClient(config.profilePath, { signalOwner: "caller" });
      assert.fail("startup must fail before runner assignment");
    },
  });
  assert.equal(launches, 1);
  assert.equal(result.digest.globalStop, true);
  assert.equal(result.digest.counts.checkpointed, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(
    JSON.parse(await readFile(join(root, "media-safety.json"))).code,
    "MEDIA_BROWSER_CLEANUP",
  );
  const first = (await readMediaQueue({ statePath, courseKey: selected[0].key })).record.queue[0];
  assert.equal(first.safetyFailure, "MEDIA_BROWSER_CLEANUP");
  assert.equal(first.retryable, false);
  const second = (await readMediaQueue({ statePath, courseKey: selected[1].key })).record.queue[0];
  assert.deepEqual(second, secondBefore);
});
