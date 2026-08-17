import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mediaCourseStatus,
  mediaCourseStatusPath,
  mediaRecordingStatusPath,
  writeMediaCourseStatus,
  writeMediaRecordingStatus,
} from "../src/media/status.mjs";

const COURSE = {
  key: "MH1101",
  courseId: "_9_1",
  mediaMode: "pilot",
};

test("renders an independent course status from durable recording states", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-status-"));
  const course = { ...COURSE, destination: join(root, "course") };
  const complete = recording({
    recordingId: "gallery-complete",
    title: "Week 1",
    provider: "kaltura",
    sourceKind: "media-gallery",
    complete: true,
    stage: "complete",
    verdict: "green",
    retryable: false,
    transcript: { complete: true, sourceKind: "provider", language: "en-SG" },
    media: {
      video: { available: true, quality: 720, audio: true, path: "/media/week-1.mp4" },
      audio: { available: true, quality: null, audio: true, path: "/media/week-1.mp4" },
    },
  });
  const queued = recording({
    recordingId: "gallery-queued",
    title: "Week 2",
    provider: "kaltura",
    sourceKind: "media-gallery",
  });

  const summary = mediaCourseStatus({
    course,
    discovery: { complete: true, verdict: "green" },
    queue: [complete, queued],
    now: () => new Date("2026-08-16T01:02:03.000Z"),
  });

  assert.equal(summary.verdict, "yellow");
  assert.deepEqual(summary.counts, {
    total: 2,
    complete: 1,
    queued: 1,
    active: 0,
    checkpointed: 0,
    failed: 0,
    withdrawn: 0,
  });

  const saved = await writeMediaCourseStatus({
    course,
    discovery: { complete: true, verdict: "green" },
    queue: [complete, queued],
    now: () => new Date("2026-08-16T01:02:03.000Z"),
  });
  assert.equal(saved.path, mediaCourseStatusPath(course));
  const content = await readFile(saved.path, "utf8");
  assert.match(content, /# MH1101 — media status/);
  assert.match(content, /Verdict: yellow/);
  assert.match(content, /Week 1/);
  assert.match(content, /Provider: Kaltura/);
  assert.match(content, /Transcript provenance: provider source \+ formatted Markdown/);
  assert.match(content, /Video: available \(720p\)/);
  assert.match(content, /Audio: available/);
  assert.match(content, /Stage: queued/);
});

test("marks discovery and attempted incomplete work red while retaining retry evidence", async () => {
  const course = { ...COURSE, destination: "/courses/MH1101/NTULearn" };
  const failed = recording({
    recordingId: "gallery-failed",
    title: "Week 3",
    provider: "unsupported",
    sourceKind: "media-gallery",
    stage: "pending",
    verdict: "red",
    limitations: ["Formatted transcript is missing."],
    retryable: true,
    attempts: 2,
    lastError: "provider transcript unavailable",
  });

  const summary = mediaCourseStatus({
    course,
    discovery: { complete: false, verdict: "red", limitations: ["count mismatch"] },
    queue: [failed],
  });

  assert.equal(summary.verdict, "red");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.recordings[0].retryable, true);
  assert.match(summary.recordings[0].limitations[0], /formatted transcript/i);
  assert.equal(summary.recordings[0].attempts, 2);
  assert.match(summary.recordings[0].lastError, /provider transcript/i);
});

test("keeps the known external provider name in unsupported status", () => {
  const appearance = {
    recordingId: "content-tree:_9_1:item-1:unsupported:feedbackfruits:activity-1",
    title: "Peer feedback",
    provider: "unsupported",
    providerName: "FeedbackFruits",
    providerShape: "feedbackfruits",
    sourceKind: "launch-link",
  };

  const summary = mediaCourseStatus({
    course: COURSE,
    discovery: { complete: true, verdict: "green" },
    queue: [appearance],
  });

  assert.equal(summary.recordings[0].provider, "FeedbackFruits");
  assert.equal(summary.recordings[0].retryable, true);
});

test("writes a per-recording status with the complete media contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-recording-status-"));
  const appearance = {
    recordingId: "content-tree:_9_1:item-1:youtube:lecture-1",
    title: "Week 4",
    provider: "youtube",
    sourceKind: "embedded-player",
    placement: {
      destination: join(root, "course"),
      statusPath: "Media Gallery/Week 4.media-status.md",
    },
  };
  const saved = await writeMediaRecordingStatus({
    appearance,
    job: recording({
      recordingId: appearance.recordingId,
      title: appearance.title,
      provider: "youtube",
      sourceKind: "embedded-player",
      stage: "red",
      verdict: "red",
      retryable: true,
      limitations: ["Browser playback audio probe was silent."],
      attempts: 1,
      lastError: "capture failed",
    }),
    now: () => new Date("2026-08-16T04:00:00.000Z"),
  });

  assert.equal(saved.path, mediaRecordingStatusPath(appearance));
  const content = await readFile(saved.path, "utf8");
  assert.match(content, /Provider: Youtube/);
  assert.match(content, /Source: embedded-player/);
  assert.match(content, /Stage: red/);
  assert.match(content, /Video: unavailable/);
  assert.match(content, /Audio: unavailable/);
  assert.match(content, /Transcript provenance: not complete/);
  assert.match(content, /Retryable: yes/);
  assert.match(content, /Attempts: 1/);
  assert.match(content, /capture failed/);
});

function recording({
  recordingId,
  title,
  provider,
  sourceKind,
  complete = false,
  stage,
  verdict,
  retryable = true,
  transcript = null,
  media = null,
  limitations = [],
  attempts = 0,
  lastError = null,
}) {
  return {
    recordingId,
    title,
    provider,
    providerName: provider,
    sourceKind,
    complete,
    ...(stage ? { stage } : {}),
    ...(verdict ? { verdict } : {}),
    retryable,
    ...(transcript ? { transcript } : {}),
    ...(media ? { media } : {}),
    limitations,
    attempts,
    lastError,
  };
}
