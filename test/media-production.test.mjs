import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  let closes = 0;

  const signalProcessGroup = () => false;
  const options = {
    signalProcessGroup,
    config: { statePath, courses, media: { mediaRoot } },
    mode: "manual",
    verifyRuntime: async () => {
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

test("turns unsupported appearances into terminal red failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-production-unsupported-"));
  const statePath = join(root, "state.json");
  const selected = { ...course("AB1001", "pilot"), destination: join(root, "course") };
  await queue(statePath, selected, "unsupported", "opaque-1");
  let composed = false;
  const options = {
    config: { statePath, courses: [selected], media: {} },
    mode: "manual",
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
