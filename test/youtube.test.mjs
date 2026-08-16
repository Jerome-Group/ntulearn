import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createYoutubeProvider, isYoutubeUrl, youtubeReferenceOf } from "../src/media/youtube.mjs";

test("recognises video URLs but not ordinary YouTube pages", () => {
  assert.equal(isYoutubeUrl("https://www.youtube.com/watch?v=lecture123"), true);
  assert.equal(
    youtubeReferenceOf("https://www.youtube.com/watch?v=lecture123"),
    "youtube:lecture123",
  );
  assert.equal(youtubeReferenceOf("https://youtu.be/lecture123?si=secret"), "youtube:lecture123");
  assert.equal(
    youtubeReferenceOf("https://www.youtube.com/embed/lecture123"),
    "youtube:lecture123",
  );
  assert.equal(youtubeReferenceOf({ videoId: "object-video" }), "youtube:object-video");
  assert.equal(youtubeReferenceOf("https://www.youtube.com/channel/example"), null);
  assert.equal(youtubeReferenceOf("https://example.test/lecture.mp4"), null);
});

test("resolves fresh YouTube data, preserves captions, prefers 720p, and remuxes", async () => {
  const calls = [];
  const provider = createYoutubeProvider({
    async resolveVideo(value) {
      calls.push(["resolve", value]);
      return {
        duration: 10,
        transcript: {
          body: "WEBVTT\n\n00:00.000 --> 00:10.000\nThe lecture text.",
          filename: "captions.vtt",
          language: "en-SG",
        },
        media: {
          video: [
            { height: 1080, url: "https://youtube.test/1080?token=secret" },
            { height: 720, url: "https://youtube.test/720?token=secret" },
          ],
        },
      };
    },
    async download(url, options) {
      calls.push(["download", url, options]);
      return { body: Buffer.from("transport bytes") };
    },
    async remux(input, options) {
      calls.push(["remux", input, options]);
      return { body: Buffer.from("remuxed bytes"), filename: "lecture.mp4" };
    },
  });

  const appearance = { providerReference: "youtube:lecture123" };
  const resolved = await provider.resolve(appearance);
  const transcript = await provider.transcript(resolved);
  const media = await provider.media(resolved);

  assert.deepEqual(calls[0], ["resolve", { reference: "youtube:lecture123", fresh: true }]);
  assert.equal(transcript.filename, "captions.vtt");
  assert.equal(transcript.language, "en-SG");
  assert.deepEqual(calls[1], [
    "download",
    "https://youtube.test/720?token=secret",
    { fresh: true },
  ]);
  assert.equal(calls[2][0], "remux");
  assert.equal(calls[2][2].reencode, false);
  assert.deepEqual(media, {
    kind: "video",
    body: Buffer.from("remuxed bytes"),
    filename: "lecture.mp4",
    quality: 720,
    audio: true,
  });
});

test("materializes a caption track through a fresh provider URL", async () => {
  const calls = [];
  const provider = createYoutubeProvider({
    async resolveVideo() {
      return {
        captionTracks: [
          {
            baseUrl: "https://youtube.test/captions?token=secret",
            language: "en-SG",
          },
        ],
      };
    },
    async download(url, options) {
      calls.push([url, options]);
      return { body: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello." };
    },
    async remux() {
      throw new Error("media is not part of this caption test");
    },
  });

  const transcript = await provider.transcript(
    await provider.resolve({ providerReference: "youtube:caption123" }),
  );

  assert.deepEqual(calls, [["https://youtube.test/captions?token=secret", { fresh: true }]]);
  assert.equal(transcript.language, "en-SG");
  assert.match(transcript.body, /Hello/);
});

test("retains audio when YouTube video acquisition fails", async () => {
  const attempted = [];
  const provider = createYoutubeProvider({
    async resolveVideo() {
      return {
        media: {
          video: [{ height: 720, url: "https://youtube.test/video" }],
          audio: [{ url: "https://youtube.test/audio" }],
        },
      };
    },
    async download(url) {
      attempted.push(url);
      if (url.endsWith("/video")) throw new Error("video unavailable");
      return Buffer.from("audio transport");
    },
    async remux(input) {
      return { body: Buffer.from(`remuxed ${input.toString()}`), filename: "lecture.m4a" };
    },
  });

  const media = await provider.media(await provider.resolve({ providerReference: "youtube:one" }));

  assert.deepEqual(attempted, ["https://youtube.test/video", "https://youtube.test/audio"]);
  assert.equal(media.kind, "audio");
  assert.match(media.limitation, /video unavailable.*audio-only/i);
  assert.equal(media.retryable, true);
  assert.equal(media.audio, true);
});
