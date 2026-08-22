import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProductionMedia } from "../src/media/production.mjs";
import { readMediaQueue, writeMediaQueue } from "../src/media/queue.mjs";

test("runs all enabled courses and providers under one aggregate digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-production-"));
  const statePath = join(root, "state.json");
  const courses = [course("AB1001"), course("AB1002")];
  await queue(statePath, courses[0], "kaltura", "entry-1");
  await queue(statePath, courses[1], "youtube", "video-1");
  let preflights = 0;
  let closes = 0;

  const result = await runProductionMedia({
    config: { statePath, courses, media: {} },
    mode: "manual",
    verifyRuntime: async () => {
      preflights += 1;
      return { runtime: {} };
    },
    createJobRunner: async () => ({
      run: async () => completeResult(),
      close: async () => {
        closes += 1;
      },
    }),
    lock: null,
  });

  assert.equal(result.digest.verdict, "green");
  assert.equal(result.digest.counts.completed, 2);
  assert.equal(result.digest.counts.total, 2);
  assert.equal(result.exitCode, 0);
  assert.equal(preflights, 1);
  assert.equal(closes, 1);
});

test("turns unsupported appearances into terminal red failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-production-unsupported-"));
  const statePath = join(root, "state.json");
  const selected = course("AB1001", "pilot");
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
      queue: [{ recordingId, provider, limitation: `${provider} limitation` }],
    },
  });
}

function completeResult() {
  return {
    complete: true,
    stage: "complete",
    verdict: "green",
    transcript: { complete: true, sourceKind: "generated", language: "en" },
  };
}
