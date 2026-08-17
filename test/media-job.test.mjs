import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMediaJob } from "../src/media/job.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";
import { transcriptDigest } from "../src/media/transcript.mjs";

test("runs a Gallery appearance through the existing media-job seam", async () => {
  const appearance = {
    recordingId: "media-gallery:_9_1:gallery-1",
    provider: "kaltura",
    providerReference: "entry:one",
    sourceKind: "media-gallery",
    storageSurface: "media-gallery",
    title: "Lecture",
    placement: {
      destination: "/courses/MH1101/NTULearn",
      formattedTranscriptPath: "Media Gallery/Lecture.transcript.md",
      statusPath: "Media Gallery/Lecture.media-status.md",
      videoPath: "Media Gallery/Lecture.mp4",
      audioPath: "Media Gallery/Lecture.m4a",
    },
  };
  const writes = [];
  let captureAttempted = false;
  const provider = {
    name: "kaltura",
    async resolve() {
      return {
        duration: 10,
        transcript: {
          body: JSON.stringify({
            language: "en",
            segments: [{ start: 0, end: 10, text: "The value is 2 + 2." }],
          }),
          filename: "captions.json",
        },
      };
    },
    async transcript(resolved) {
      return resolved.transcript;
    },
    async media() {
      return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4", audio: true };
    },
  };
  const storage = {
    async write({ kind }) {
      writes.push(kind);
      return { path: `gallery/${kind}`, status: "written" };
    },
  };
  const formatter = {
    version: "gallery-formatter-1",
    async format() {
      return { markdown: "The value is 2 + 2." };
    },
  };

  const result = await runMediaJob({
    appearance,
    provider,
    playbackCapture: {
      async media() {
        captureAttempted = true;
        throw new Error("capture must remain behind provider media");
      },
    },
    storage,
    formatter,
  });

  assert.equal(result.complete, true);
  assert.equal(captureAttempted, false);
  assert.deepEqual(writes.sort(), [
    "formatted-transcript",
    "media",
    "metadata",
    "provider-transcript",
    "raw-transcript",
    "state",
    "status",
  ]);
});

test("stores file-backed media before releasing its temporary source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-job-file-backed-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const sourcePath = join(root, "runtime", "recording.mp4");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(sourcePath, "file-backed video");
  const appearance = {
    ...recordingAppearance(),
    placement: {
      ...recordingAppearance().placement,
      destination: join(root, "course"),
    },
  };
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  let cleanupCalled = false;
  let transcriberMedia;
  const result = await runMediaJob({
    appearance,
    provider: {
      name: "kaltura",
      async resolve() {
        return { duration: 10 };
      },
      async transcript() {
        return null;
      },
      async media() {
        return {
          kind: "video",
          sourcePath,
          filename: "lecture.mp4",
          quality: 720,
          audio: true,
          cleanup: async () => {
            cleanupCalled = true;
            await unlink(sourcePath);
          },
        };
      },
    },
    storage,
    transcriber: {
      version: "whisper-test",
      async transcribe({ media }) {
        transcriberMedia = media;
        return {
          sourceKind: "generated",
          language: "en",
          segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
        };
      },
      async release() {},
    },
    formatter: {
      version: "formatter-test",
      async format({ segments }) {
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
  });

  assert.equal(result.complete, true);
  assert.equal(cleanupCalled, true);
  assert.equal(transcriberMedia.body, undefined);
  assert.equal(await readFile(transcriberMedia.path, "utf8"), "file-backed video");
});

test("persists media before a checkpoint so the next run does not reacquire it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-job-resume-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const baseStorage = createMediaStorage({ mediaRoot, volumeRoot });
  const appearance = {
    ...recordingAppearance(),
    placement: {
      ...recordingAppearance().placement,
      destination: join(root, "course"),
    },
  };
  const controller = new globalThis.AbortController();
  let mediaWrites = 0;
  let mediaCalls = 0;
  const storage = {
    async write(value) {
      const result = await baseStorage.write(value);
      if (value.kind === "media") {
        mediaWrites += 1;
        const error = new Error("04:00 checkpoint");
        error.code = "MEDIA_CHECKPOINT";
        controller.abort(error);
      }
      return result;
    },
    read: baseStorage.read,
  };
  const provider = {
    name: "kaltura",
    async resolve() {
      return { duration: 10 };
    },
    async transcript() {
      return null;
    },
    async media() {
      mediaCalls += 1;
      return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4", audio: true };
    },
  };

  const first = await runMediaJob({ appearance, provider, storage, signal: controller.signal });

  assert.equal(first.stage, "checkpointed");
  assert.equal(first.complete, false);
  assert.equal(mediaWrites, 1);
  assert.equal(mediaCalls, 1);

  const second = await runMediaJob({
    appearance,
    provider: {
      ...provider,
      async media() {
        throw new Error("resume must use retained media");
      },
    },
    storage,
  });

  assert.equal(second.complete, false);
  assert.equal(mediaWrites, 1);
  assert.equal(mediaCalls, 1);
});

test("runs the provider transcript and independent media paths through one pure job seam", async () => {
  const writes = [];
  const calls = [];
  const appearance = recordingAppearance();
  const native = {
    body: Buffer.from(
      JSON.stringify({
        language: "en-SG",
        segments: [
          { start: 0, end: 4, text: "The value is 2 + 2." },
          { start: 4, end: 10, text: "It is 4." },
        ],
      }),
    ),
    filename: "captions.json",
  };
  const provider = {
    name: "kaltura",
    async resolve(received) {
      calls.push("resolve");
      assert.equal(received, appearance);
      return {
        duration: 10,
        transcript: native,
        media: {
          video: [
            { id: "1080", height: 1080, url: "https://media.test/1080.m3u8?ks=secret" },
            { id: "720", height: 720, url: "https://media.test/720.m3u8?ks=secret" },
          ],
        },
      };
    },
    async transcript(resolved) {
      calls.push("transcript");
      return resolved.transcript;
    },
    async media(resolved) {
      calls.push("media");
      assert.equal(resolved.media.video[1].height, 720);
      return {
        kind: "video",
        body: Buffer.from("remuxed video"),
        filename: "lecture.mp4",
        quality: 720,
        audio: true,
      };
    },
  };
  const model = {
    async generate({ segments }) {
      calls.push("format");
      assert.equal(segments.length, 2);
      return { markdown: `# Lecture\n\n${segments.map(({ text }) => text).join(" ")}` };
    },
  };
  const formatter = {
    version: "local-test-formatter-1",
    format: ({ segments }) => model.generate({ segments }),
  };
  const storage = {
    async write({ kind, content }) {
      writes.push({ kind, content });
      return { path: `media/${kind}` };
    },
  };

  const result = await runMediaJob({
    appearance,
    provider,
    storage,
    formatter,
    clock: () => new Date("2026-08-16T01:02:03.000Z"),
  });

  assert.deepEqual(calls, ["resolve", "transcript", "media", "format"]);
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "green");
  assert.equal(result.stage, "complete");
  assert.equal(result.transcript.sourceKind, "provider");
  assert.equal(result.duration, 10);
  assert.deepEqual(writes.map(({ kind }) => kind).sort(), [
    "formatted-transcript",
    "media",
    "metadata",
    "provider-transcript",
    "raw-transcript",
    "state",
    "status",
  ]);
  assert.deepEqual(writes.find(({ kind }) => kind === "provider-transcript").content, native.body);
  assert.match(writes.find(({ kind }) => kind === "raw-transcript").content, /"language": "en-SG"/);
  assert.match(writes.find(({ kind }) => kind === "formatted-transcript").content, /2 \+ 2/);
  assert.doesNotMatch(
    writes.find(({ kind }) => kind === "formatted-transcript").content,
    /\b\d{1,2}:\d{2}\b/,
  );

  const metadata = JSON.parse(writes.find(({ kind }) => kind === "metadata").content);
  assert.deepEqual(metadata, {
    recordingId: appearance.recordingId,
    provider: "kaltura",
    sourceKind: "provider",
    recordingReference: "entry:lecture-1",
    sourceSha256: metadata.sourceSha256,
    formattedSha256: metadata.formattedSha256,
    language: "en-SG",
    duration: 10,
    formatterVersion: "local-test-formatter-1",
    media: {
      video: { available: true, path: "media/media", quality: 720, audio: true },
      audio: { available: true, path: "media/media", quality: null, audio: true },
    },
    limitations: [],
  });
  assert.match(metadata.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(metadata.formattedSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|ks=secret/);
  const state = JSON.parse(writes.find(({ kind }) => kind === "state").content);
  assert.equal(state.sourceKind, "provider");
  assert.equal(state.duration, 10);
  assert.equal(state.sourceSha256, metadata.sourceSha256);
  assert.equal(state.artifacts.formattedTranscript, "media/formatted-transcript");
  const status = writes.find(({ kind }) => kind === "status").content;
  assert.match(status, /Video: available/);
  assert.match(status, /Duration: 10\.0s/);
  assert.match(status, /Transcript provenance: en-SG provider source \+ formatted Markdown/);
});

test("rejects an invalid provider transcript after still attempting media acquisition", async () => {
  const writes = [];
  let mediaAttempted = false;
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        return {
          duration: 100,
          transcript: {
            body: JSON.stringify({
              language: "en",
              segments: [
                { start: 10, end: 11, text: "too short" },
                { start: 4, end: 5, text: "out of order" },
              ],
            }),
            filename: "captions.json",
          },
        };
      },
      async transcript(resolved) {
        return resolved.transcript;
      },
      async media() {
        mediaAttempted = true;
        return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4" };
      },
    },
    formatter: { version: "unused", format: async () => ({ markdown: "unused" }) },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(mediaAttempted, true);
  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.equal(result.stage, "pending");
  assert.match(result.limitation, /provider transcript rejected/i);
  assert.deepEqual(
    writes.map(({ kind }) => kind),
    ["provider-transcript", "media", "state", "status"],
  );
  assert.match(writes.at(-1).content, /local transcription is not configured/i);
});

test("captures only after provider media is unavailable and sends captured audio through local ASR", async () => {
  const events = [];
  const writes = [];
  const appearance = recordingAppearance();
  const result = await runMediaJob({
    appearance,
    provider: {
      name: "opaque-player",
      async resolve() {
        events.push("resolve");
        return { duration: 10 };
      },
      async transcript() {
        events.push("transcript");
        return null;
      },
      async media() {
        events.push("media");
        return {
          kind: "unavailable",
          limitation: "Authenticated media retrieval exposed no usable representation.",
          retryable: true,
        };
      },
    },
    playbackCapture: {
      async media({ resolved }) {
        events.push("capture");
        assert.deepEqual(resolved, { duration: 10 });
        return {
          kind: "audio",
          body: Buffer.from("captured lecture audio"),
          filename: "lecture.m4a",
          limitation: "Browser playback capture retained audio-only media.",
        };
      },
    },
    transcriber: {
      version: "whisper-small.en",
      async transcribe({ media }) {
        events.push(`transcribe:${media.kind}`);
        assert.equal(media.body.toString(), "captured lecture audio");
        return {
          language: "en-SG",
          segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
        };
      },
      async release() {
        events.push("release");
      },
    },
    formatter: {
      version: "formatter-1",
      async format({ segments }) {
        events.push("format");
        return { markdown: segments[0].text };
      },
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.deepEqual(events, [
    "resolve",
    "transcript",
    "media",
    "capture",
    "transcribe:audio",
    "release",
    "format",
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "yellow");
  assert.equal(result.media.video.available, false);
  assert.equal(result.media.audio.available, true);
  assert.match(result.limitations.join(" "), /audio-only/);
  assert.match(writes.find(({ kind }) => kind === "status").content, /audio-only/);
});

test("exhausts provider paths before capture when provider resolution fails", async () => {
  const events = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "opaque-player",
      async resolve() {
        events.push("resolve");
        throw new Error("provider metadata unavailable");
      },
      async transcript(resolved) {
        events.push(`transcript:${resolved}`);
        return null;
      },
      async media(resolved) {
        events.push(`media:${resolved}`);
        return { kind: "unavailable", limitation: "no authenticated media", retryable: true };
      },
    },
    playbackCapture: {
      async media({ resolved }) {
        events.push(`capture:${resolved}`);
        return { kind: "audio", body: Buffer.from("captured audio"), filename: "lecture.m4a" };
      },
    },
    storage: {
      async write({ kind }) {
        return { path: `media/${kind}` };
      },
    },
  });

  assert.deepEqual(events, ["resolve", "transcript:null", "media:null", "capture:null"]);
  assert.equal(result.complete, false);
  assert.match(result.limitations.join(" "), /Provider resolution failed/);
});

test("does not retain capture output after a forced checkpoint", async () => {
  const controller = new globalThis.AbortController();
  const writes = [];
  const provider = validProvider();
  provider.media = async () => ({
    kind: "unavailable",
    limitation: "no authenticated media",
    retryable: true,
  });

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider,
    playbackCapture: {
      async media({ signal }) {
        controller.abort(new Error("04:00 checkpoint"));
        assert.equal(signal, controller.signal);
        return { kind: "video", body: Buffer.from("must not commit") };
      },
    },
    formatter: {
      version: "formatter-1",
      format: async () => ({ markdown: "The value is 2 + 2 = 4." }),
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
    signal: controller.signal,
  });

  assert.equal(result.complete, false);
  assert.equal(result.stage, "red");
  assert.equal(
    writes.some(({ kind }) => kind === "media"),
    false,
  );
  assert.match(result.limitations.join(" "), /interrupted/i);
});

test("keeps a silent browser fallback red even when the provider transcript is complete", async () => {
  const writes = [];
  const provider = validProvider();
  provider.media = async () => ({
    kind: "unavailable",
    limitation: "Authenticated media retrieval exposed no usable representation.",
    retryable: true,
  });

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider,
    playbackCapture: {
      async media() {
        return {
          kind: "unavailable",
          limitation: "Browser playback audio probe was silent or unintelligible; capture aborted.",
          retryable: true,
        };
      },
    },
    formatter: {
      version: "formatter-1",
      format: async () => ({ markdown: "The value is 2 + 2 = 4." }),
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.equal(result.stage, "red");
  assert.equal(result.retryable, true);
  assert.match(result.limitation, /no usable representation/i);
  assert.match(writes.find(({ kind }) => kind === "status").content, /silent or unintelligible/i);
});

test("generates a transcript from acquired audio and releases ASR before formatting", async () => {
  const writes = [];
  const events = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        return {
          duration: 10,
          transcript: {
            body: JSON.stringify({
              language: "en",
              segments: [{ start: 0, end: 1, text: "too short" }],
            }),
            filename: "captions.json",
          },
        };
      },
      async transcript(resolved) {
        return resolved.transcript;
      },
      async media() {
        return {
          kind: "audio",
          body: Buffer.from("retained lecture audio"),
          filename: "lecture.m4a",
        };
      },
    },
    transcriber: {
      version: "whisper-medium.en",
      runtimeMetadata: {
        selectedModel: {
          name: "medium.en",
          revision: "r1",
          sha256: "a".repeat(64),
          license: "MIT",
        },
      },
      async transcribe({ media }) {
        events.push(`transcribe:${media.kind}:${media.body.toString()}`);
        return {
          language: "en-SG",
          segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
        };
      },
      async release() {
        events.push("release");
      },
    },
    formatter: {
      version: "formatter-1",
      async format({ segments }) {
        events.push("format");
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.deepEqual(events, ["transcribe:audio:retained lecture audio", "release", "format"]);
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "yellow");
  assert.equal(result.retryable, false);
  assert.equal(result.transcript.sourceKind, "generated");
  assert.equal(result.media.video.available, false);
  assert.equal(result.media.audio.available, true);
  assert.match(writes.find(({ kind }) => kind === "status").content, /Media: audio-only/);
  assert.match(
    writes.find(({ kind }) => kind === "status").content,
    /generated source \+ formatted Markdown/,
  );
  const metadata = JSON.parse(writes.find(({ kind }) => kind === "metadata").content);
  assert.equal(metadata.sourceKind, "generated");
  assert.equal(metadata.asr.selectedModel.name, "medium.en");
  const state = JSON.parse(writes.find(({ kind }) => kind === "state").content);
  assert.equal(state.transcriberVersion, "whisper-medium.en");
  assert.equal(state.asr.selectedModel.name, "medium.en");
});

test("records non-speech without inventing text or invoking the formatter", async () => {
  let formatted = false;
  const writes = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        return {
          duration: 10,
          transcript: { body: JSON.stringify({ language: "en", segments: [] }) },
        };
      },
      async transcript(resolved) {
        return resolved.transcript;
      },
      async media() {
        return { kind: "audio", body: Buffer.from("music"), filename: "lecture.m4a" };
      },
    },
    transcriber: {
      version: "whisper-small.en",
      async transcribe() {
        return { sourceKind: "non-speech", language: "und", reason: "music only" };
      },
      async release() {},
    },
    formatter: {
      version: "formatter-1",
      async format() {
        formatted = true;
        return { markdown: "invented words" };
      },
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(formatted, false);
  assert.equal(result.complete, true);
  assert.equal(result.transcript.sourceKind, "non-speech");
  assert.match(writes.find(({ kind }) => kind === "formatted-transcript").content, /music only/);
  assert.match(writes.find(({ kind }) => kind === "status").content, /non-speech source/);
});

test("reuses retained media when retrying a failed transcript", async () => {
  const writes = [];
  let mediaAttempted = false;
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        return { duration: 10 };
      },
      async transcript() {
        return null;
      },
      async media() {
        mediaAttempted = true;
        throw new Error("retained media should be reused");
      },
    },
    transcriber: {
      version: "whisper-small.en",
      runtimeMetadata: { selectedModel: { name: "small.en" } },
      async transcribe({ media }) {
        assert.equal(media.path, "course/Lecture.mp4");
        return {
          language: "en-SG",
          segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
        };
      },
      async release() {},
    },
    formatter: {
      version: "formatter-1",
      async format({ segments }) {
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: {
      async read({ kind }) {
        return kind === "state"
          ? {
              path: "media/transcript.state.json",
              content: JSON.stringify({
                provider: "kaltura",
                media: {
                  video: {
                    available: true,
                    path: "course/Lecture.mp4",
                    quality: 720,
                    audio: true,
                  },
                  audio: {
                    available: true,
                    path: "course/Lecture.mp4",
                    quality: null,
                    audio: true,
                  },
                },
                artifacts: { media: "course/Lecture.mp4" },
              }),
            }
          : null;
      },
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}`, status: "written" };
      },
    },
  });

  assert.equal(mediaAttempted, false);
  assert.equal(result.complete, true);
  assert.equal(result.media.video.available, true);
  assert.equal(result.transcript.sourceKind, "generated");
  assert.match(result.limitation, /no provider transcript/i);
});

test("does not revisit a successful source and derivative during a routine run", async () => {
  const writes = [];
  const appearance = recordingAppearance();
  const rawContent = JSON.stringify({
    sourceKind: "generated",
    language: "en-SG",
    segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
  });
  const stored = new Map([
    [
      "raw-transcript",
      {
        path: "media/transcript.raw.json",
        content: rawContent,
      },
    ],
    [
      "formatted-transcript",
      { path: "course/Lecture.transcript.md", content: "The value is 2 + 2 = 4.\n" },
    ],
    [
      "metadata",
      {
        path: "media/transcript.metadata.json",
        content: JSON.stringify({
          recordingId: appearance.recordingId,
          provider: "kaltura",
          sourceKind: "generated",
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest("The value is 2 + 2 = 4.\n"),
          language: "en-SG",
          formatterVersion: "formatter-1",
          limitations: [],
          media: {
            video: { available: false, path: null, quality: null, audio: false },
            audio: { available: true, path: "course/Lecture.m4a", quality: null, audio: true },
          },
        }),
      },
    ],
  ]);

  const result = await runMediaJob({
    appearance,
    provider: {
      async resolve() {
        throw new Error("provider should not be revisited");
      },
    },
    transcriber: {
      version: "whisper-small.en",
      async transcribe() {
        throw new Error("ASR should not be revisited");
      },
    },
    formatter: {
      version: "formatter-2",
      async format() {
        throw new Error("formatter should not be revisited");
      },
    },
    storage: {
      async read({ kind }) {
        return stored.get(kind) ?? null;
      },
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.transcript.sourceKind, "generated");
  assert.deepEqual(
    writes.map(({ kind }) => kind),
    ["state", "status"],
  );
  assert.equal(result.media.audio.available, true);
});

test("retries missing media capture without revisiting an existing source or derivative", async () => {
  const appearance = recordingAppearance();
  const rawContent = JSON.stringify({
    sourceKind: "generated",
    language: "en-SG",
    segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
  });
  const formattedContent = "The value is 2 + 2 = 4.\n";
  const media = {
    video: { available: false, path: null, quality: null, audio: false },
    audio: { available: false, path: null, quality: null, audio: false },
  };
  const stored = new Map([
    ["raw-transcript", { path: "media/transcript.raw.json", content: rawContent }],
    ["formatted-transcript", { path: "course/Lecture.transcript.md", content: formattedContent }],
    [
      "metadata",
      {
        path: "media/transcript.metadata.json",
        content: JSON.stringify({
          recordingId: appearance.recordingId,
          provider: "kaltura",
          sourceKind: "generated",
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(formattedContent),
          language: "en-SG",
          formatterVersion: "formatter-1",
          limitations: [],
          media,
        }),
      },
    ],
    [
      "state",
      {
        path: "media/transcript.state.json",
        content: JSON.stringify({
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(formattedContent),
          media,
          artifacts: {
            rawTranscript: "media/transcript.raw.json",
            formattedTranscript: "course/Lecture.transcript.md",
          },
        }),
      },
    ],
  ]);
  const events = [];
  const result = await runMediaJob({
    appearance,
    provider: {
      name: "kaltura",
      async resolve() {
        events.push("resolve");
        return { duration: 10 };
      },
      async transcript() {
        throw new Error("existing source should skip provider transcript");
      },
      async media() {
        events.push("media");
        return { kind: "unavailable", limitation: "direct media unavailable", retryable: true };
      },
    },
    playbackCapture: {
      async media() {
        events.push("capture");
        return { kind: "video", body: Buffer.from("captured video"), filename: "lecture.mp4" };
      },
    },
    formatter: {
      version: "formatter-2",
      async format() {
        throw new Error("existing derivative should skip formatting");
      },
    },
    transcriber: {
      async transcribe() {
        throw new Error("existing source should skip ASR");
      },
    },
    storage: {
      async read({ kind }) {
        return stored.get(kind) ?? null;
      },
      async write({ kind }) {
        return { path: `media/${kind}` };
      },
    },
  });

  assert.deepEqual(events, ["resolve", "media", "capture"]);
  assert.equal(result.complete, true);
  assert.equal(result.media.video.available, true);
  assert.equal(result.transcript.complete, true);
});

test("replaces a corrupt existing derivative without revisiting its source", async () => {
  const writes = [];
  const rawContent = JSON.stringify({
    sourceKind: "generated",
    language: "en-SG",
    segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
  });
  const stored = new Map([
    [
      "raw-transcript",
      {
        path: "media/transcript.raw.json",
        content: rawContent,
      },
    ],
    ["formatted-transcript", { path: "course/Lecture.transcript.md", content: "" }],
    [
      "metadata",
      {
        path: "media/transcript.metadata.json",
        content: JSON.stringify({
          provider: "kaltura",
          formatterVersion: "formatter-1",
          limitations: [],
          media: {
            video: { available: false, path: null, quality: null, audio: false },
            audio: { available: true, path: "course/Lecture.m4a", quality: null, audio: true },
          },
        }),
      },
    ],
    [
      "state",
      {
        path: "media/transcript.state.json",
        content: JSON.stringify({
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(""),
          artifacts: {
            rawTranscript: "media/transcript.raw.json",
            formattedTranscript: "course/Lecture.transcript.md",
          },
        }),
      },
    ],
  ]);

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    regenerate: true,
    provider: {
      async resolve() {
        throw new Error("provider should not be revisited");
      },
    },
    transcriber: {
      async transcribe() {
        throw new Error("ASR should not be revisited");
      },
    },
    formatter: {
      version: "formatter-2",
      async format({ segments }) {
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: {
      async read({ kind }) {
        return stored.get(kind) ?? null;
      },
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.transcript.complete, true);
  const replacement = writes.find(({ kind }) => kind === "formatted-transcript");
  assert.equal(replacement.replaceProof.path, "course/Lecture.transcript.md");
  assert.equal(replacement.replaceProof.sha256, transcriptDigest(""));
  assert.equal(replacement.replaceProof.sourceSha256, transcriptDigest(rawContent));
});

test("regenerates an owned formatted derivative when explicitly requested", async () => {
  const writes = [];
  let formatCalls = 0;
  const rawContent = JSON.stringify({
    sourceKind: "generated",
    language: "en-SG",
    segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
  });
  const formattedPath = "course/Lecture.transcript.md";
  const formattedContent = "The value is 2 + 2 = 4.";
  const media = {
    video: { available: true, path: "course/Lecture.mp4", quality: 720, audio: true },
    audio: { available: true, path: "course/Lecture.mp4", quality: null, audio: true },
  };
  const stored = new Map([
    ["raw-transcript", { path: "media/transcript.raw.json", content: rawContent }],
    ["formatted-transcript", { path: formattedPath, content: formattedContent }],
    [
      "metadata",
      {
        path: "media/transcript.metadata.json",
        content: JSON.stringify({
          recordingId: recordingAppearance().recordingId,
          provider: "kaltura",
          sourceKind: "generated",
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(formattedContent),
          language: "en-SG",
          formatterVersion: "formatter-1",
          limitations: [],
          media,
        }),
      },
    ],
    [
      "state",
      {
        path: "media/transcript.state.json",
        content: JSON.stringify({
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(formattedContent),
          media,
          artifacts: { media: media.video.path, formattedTranscript: formattedPath },
        }),
      },
    ],
  ]);

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    regenerate: true,
    provider: {
      async resolve() {
        throw new Error("explicit regeneration should not revisit the provider");
      },
    },
    transcriber: {
      async transcribe() {
        throw new Error("explicit regeneration should not revisit ASR");
      },
    },
    formatter: {
      version: "formatter-2",
      async format({ segments }) {
        formatCalls += 1;
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: {
      async read({ kind }) {
        return stored.get(kind) ?? null;
      },
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, true);
  assert.equal(formatCalls, 1);
  const replacement = writes.find(({ kind }) => kind === "formatted-transcript");
  assert.equal(replacement.replaceProof.path, formattedPath);
  assert.equal(replacement.replaceProof.sha256, transcriptDigest(formattedContent));
  assert.equal(replacement.replaceProof.sourceSha256, transcriptDigest(rawContent));
});

test("does not replace a corrupt derivative during a routine run", async () => {
  const writes = [];
  const rawContent = JSON.stringify({
    sourceKind: "generated",
    language: "en-SG",
    segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
  });
  const formattedPath = "course/Lecture.transcript.md";
  const mediaPath = "course/Lecture.mp4";
  const media = {
    video: { available: true, path: mediaPath, quality: 720, audio: true },
    audio: { available: true, path: mediaPath, quality: null, audio: true },
  };
  const stored = new Map([
    ["raw-transcript", { path: "media/transcript.raw.json", content: rawContent }],
    ["formatted-transcript", { path: formattedPath, content: "" }],
    [
      "metadata",
      {
        path: "media/transcript.metadata.json",
        content: JSON.stringify({
          recordingId: recordingAppearance().recordingId,
          provider: "kaltura",
          sourceKind: "generated",
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(""),
          language: "en-SG",
          formatterVersion: "formatter-1",
          limitations: [],
          media,
        }),
      },
    ],
    [
      "state",
      {
        path: "media/transcript.state.json",
        content: JSON.stringify({
          sourceSha256: transcriptDigest(rawContent),
          formattedSha256: transcriptDigest(""),
          media,
          artifacts: { media: mediaPath, formattedTranscript: formattedPath },
        }),
      },
    ],
  ]);

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      async resolve() {
        throw new Error("routine regeneration must not revisit the provider");
      },
    },
    formatter: {
      version: "formatter-2",
      async format() {
        throw new Error("routine regeneration must be explicit");
      },
    },
    storage: {
      async read({ kind }) {
        return stored.get(kind) ?? null;
      },
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.transcript.complete, false);
  assert.equal(result.retryable, true);
  assert.match(result.limitations.join(" "), /explicit regeneration/i);
  assert.equal(
    writes.some(({ kind }) => kind === "formatted-transcript"),
    false,
  );
});

test("reconstructs successful work after the disposable state artifact is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-state-loss-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const baseStorage = createMediaStorage({ mediaRoot, volumeRoot });
  const appearance = {
    ...recordingAppearance(),
    placement: { ...recordingAppearance().placement, destination: join(root, "course") },
  };
  let providerCalls = 0;
  const first = await runMediaJob({
    appearance,
    provider: {
      name: "kaltura",
      async resolve() {
        providerCalls += 1;
        return {
          duration: 10,
          transcript: {
            body: JSON.stringify({
              language: "en-SG",
              segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
            }),
          },
        };
      },
      async transcript(resolved) {
        providerCalls += 1;
        return resolved.transcript;
      },
      async media() {
        providerCalls += 1;
        return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4", audio: true };
      },
    },
    formatter: {
      version: "formatter-1",
      async format({ segments }) {
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: baseStorage,
  });
  assert.equal(first.complete, true);
  const state = await baseStorage.read({ appearance, kind: "state" });
  await unlink(state.path);

  let secondProviderCalls = 0;
  const second = await runMediaJob({
    appearance,
    provider: {
      async resolve() {
        secondProviderCalls += 1;
        throw new Error("state loss must not revisit the provider");
      },
      async transcript() {
        secondProviderCalls += 1;
        throw new Error("state loss must not revisit the transcript");
      },
      async media() {
        secondProviderCalls += 1;
        throw new Error("state loss must not revisit media");
      },
    },
    formatter: {
      version: "formatter-2",
      async format() {
        throw new Error("state loss must not revisit the formatter");
      },
    },
    storage: baseStorage,
  });

  assert.equal(providerCalls, 3);
  assert.equal(secondProviderCalls, 0);
  assert.equal(second.complete, true);
  assert.equal(second.transcript.complete, true);
  assert.equal(second.media.video.available, true);
});

test("does not mark an invalid existing source complete during a routine run", async () => {
  const writes = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: validProvider(),
    formatter: {
      version: "formatter-1",
      async format({ segments }) {
        return { markdown: segments.map(({ text }) => text).join(" ") };
      },
    },
    storage: {
      async read({ kind }) {
        return kind === "raw-transcript"
          ? { path: "media/transcript.raw.json", content: "not json" }
          : null;
      },
      async write(value) {
        writes.push(value);
        return {
          path: `media/${value.kind}`,
          status: value.kind === "raw-transcript" ? "existing" : "written",
        };
      },
    },
  });

  assert.equal(result.complete, false);
  assert.match(result.limitation, /raw transcript is invalid/i);
  assert.equal(writes.find(({ kind }) => kind === "raw-transcript").replace, undefined);
});

test("does not preserve provider transcript bytes that contain session material", async () => {
  const writes = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        return {
          duration: 10,
          transcript: {
            body: JSON.stringify({
              language: "en",
              segments: [
                {
                  start: 0,
                  end: 10,
                  text: "Caption https://video.test/caption?ks=session-secret&access_token=secret&sig=secret",
                },
              ],
            }),
            filename: "captions.json",
          },
        };
      },
      async transcript(resolved) {
        return resolved.transcript;
      },
      async media() {
        return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4" };
      },
    },
    formatter: { version: "unused", format: async () => ({ markdown: "unused" }) },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, false);
  assert.match(result.limitation, /session-bound address/i);
  assert.deepEqual(
    writes.map(({ kind }) => kind),
    ["media", "state", "status"],
  );
  assert.doesNotMatch(JSON.stringify(writes), /session-secret|ks=|access_token=|sig=/);
});

test("rejects formatted output that loses a number or timestamp", async () => {
  for (const markdown of ["The value is four.", "00:00 The value is 4."]) {
    const result = await runMediaJob({
      appearance: recordingAppearance(),
      provider: validProvider(),
      storage: { write: async ({ kind }) => ({ path: `media/${kind}` }) },
      formatter: { version: "bad", format: async () => ({ markdown }) },
    });

    assert.equal(result.complete, false);
    assert.equal(result.verdict, "red");
    assert.match(result.limitation, /formatted transcript/i);
  }
});

test("redacts session-bound provider addresses from a failure status", async () => {
  const writes = [];
  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider: {
      name: "kaltura",
      async resolve() {
        throw new Error("GET https://video.test/caption?ks=secret-token failed");
      },
    },
    formatter: { version: "unused", format: async () => ({ markdown: "unused" }) },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|secret-token|ks=/);
  assert.doesNotMatch(writes.at(-1).content, /https?:\/\/|secret-token|ks=/);
  assert.match(writes.at(-1).content, /provider address omitted/);
});

test("keeps a provider media limitation visible after audio-only fallback", async () => {
  const writes = [];
  const provider = validProvider();
  provider.media = async () => ({
    kind: "audio",
    body: Buffer.from("audio"),
    filename: "lecture.m4a",
    retryable: true,
    limitation: "Video acquisition failed; retained audio-only media.",
  });

  const result = await runMediaJob({
    appearance: recordingAppearance(),
    provider,
    formatter: {
      version: "formatter-1",
      format: async () => ({ markdown: "The value is 2 + 2 = 4." }),
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.verdict, "yellow");
  assert.equal(result.retryable, true);
  assert.match(result.limitation, /audio-only/);
  assert.match(writes.find(({ kind }) => kind === "status").content, /audio-only/);
});

test("carries an unsupported discovery limitation into red job status", async () => {
  const writes = [];
  const result = await runMediaJob({
    appearance: {
      ...recordingAppearance(),
      provider: "unsupported",
      providerReference: "unsupported:player.example.test/lecture",
      limitation:
        "Unsupported recording provider shape from embedded-player; media acquisition is unavailable.",
    },
    provider: {
      name: "unsupported",
      async resolve() {
        throw new Error("unsupported provider shape");
      },
    },
    storage: {
      async write(value) {
        writes.push(value);
        return { path: `media/${value.kind}` };
      },
    },
  });

  assert.equal(result.provider, "unsupported");
  assert.equal(result.complete, false);
  assert.equal(result.retryable, true);
  assert.match(result.limitation, /unsupported recording provider shape/i);
  assert.match(writes.find(({ kind }) => kind === "status").content, /embedded-player/);
});

function validProvider() {
  return {
    name: "kaltura",
    async resolve() {
      return {
        duration: 10,
        transcript: {
          body: JSON.stringify({
            language: "en",
            segments: [{ start: 0, end: 10, text: "The value is 2 + 2 = 4." }],
          }),
          filename: "captions.json",
        },
      };
    },
    async transcript(resolved) {
      return resolved.transcript;
    },
    async media() {
      return { kind: "video", body: Buffer.from("video"), filename: "lecture.mp4" };
    },
  };
}

function recordingAppearance() {
  return {
    recordingId: "content-tree:_9_1:item-1:entry:lecture-1",
    courseKey: "MH2100",
    courseId: "_9_1",
    itemId: "item-1",
    title: "Lecture",
    trail: "Lectures",
    provider: "kaltura",
    providerReference: "entry:lecture-1",
    sourceKind: "embedded-player",
    placement: {
      destination: "/courses/MH2100/NTULearn",
      directorySegments: ["01 Lectures"],
      trail: "Lectures",
      linkPath: "01 Lectures/01 Lecture.md",
      videoPath: "01 Lectures/01 Lecture.mp4",
      videoAlreadyPresent: false,
      formattedTranscriptPath: "01 Lectures/01 Lecture.transcript.md",
      statusPath: "01 Lectures/01 Lecture.media-status.md",
    },
  };
}
