import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { runMediaJob } from "../src/media/job.mjs";

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
  assert.deepEqual(writes.map(({ kind }) => kind).sort(), [
    "formatted-transcript",
    "media",
    "metadata",
    "provider-transcript",
    "raw-transcript",
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
    language: "en-SG",
    formatterVersion: "local-test-formatter-1",
    limitations: [],
  });
  assert.match(metadata.sourceSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|ks=secret/);
  const status = writes.find(({ kind }) => kind === "status").content;
  assert.match(status, /Video: available/);
  assert.match(status, /Transcript: en-SG provider transcript/);
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
    ["provider-transcript", "media", "status"],
  );
  assert.match(writes.at(-1).content, /local transcription is not configured/i);
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
                { start: 0, end: 10, text: "Caption https://video.test/caption?ks=session-secret" },
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
    ["media", "status"],
  );
  assert.doesNotMatch(JSON.stringify(writes), /session-secret|ks=/);
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
