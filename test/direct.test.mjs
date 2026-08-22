import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  createDirectProvider,
  directMediaKindOf,
  directMediaReferenceOf,
} from "../src/media/direct.mjs";

test("classifies direct video and audio without retaining signed query strings", () => {
  const video = "https://cdn.example.test/lectures/week-1.mp4?signature=secret";
  assert.equal(directMediaKindOf(video), "video");
  assert.equal(directMediaKindOf({ fileName: "week-1.m4a", mimeType: "audio/mp4" }), "audio");
  assert.equal(directMediaReferenceOf(video), "direct:cdn.example.test/lectures/week-1.mp4");
  assert.equal(
    directMediaReferenceOf(
      "https://cdn.example.test/Lecture%201%20%E6%95%B0%E5%AD%A6.mp4?signature=secret",
    ),
    "direct:cdn.example.test/Lecture%201%20%E6%95%B0%E5%AD%A6.mp4",
  );
  assert.equal(
    directMediaReferenceOf({
      resourceUrl: video,
      fileName: "week-1.mp4",
      mimeType: "video/mp4",
    }),
    "direct:cdn.example.test/lectures/week-1.mp4",
  );
  assert.equal(directMediaKindOf("https://example.test/course/reading"), null);
});

test("resolves a fresh direct URL and remuxes without re-encoding", async () => {
  const calls = [];
  const provider = createDirectProvider({
    async resolveMedia(value) {
      calls.push(["resolve", value]);
      return { kind: "audio", url: "https://cdn.example.test/fresh.m4a?session=secret" };
    },
    async download(url, options) {
      calls.push(["download", url, options]);
      return { body: Buffer.from("transport") };
    },
    async remux(input, options) {
      calls.push(["remux", input, options]);
      return { body: Buffer.from("remuxed"), filename: "lecture.m4a" };
    },
  });

  const appearance = {
    providerReference: "direct:cdn.example.test/lecture.m4a",
    mediaType: "audio",
  };
  const resolved = await provider.resolve(appearance);
  const media = await provider.media(resolved);

  assert.deepEqual(calls[0], [
    "resolve",
    {
      appearance,
      reference: "direct:cdn.example.test/lecture.m4a",
      kind: "audio",
      fresh: true,
    },
  ]);
  assert.deepEqual(calls[1], [
    "download",
    "https://cdn.example.test/fresh.m4a?session=secret",
    { fresh: true },
  ]);
  assert.equal(calls[2][2].reencode, false);
  assert.deepEqual(media, {
    kind: "audio",
    body: Buffer.from("remuxed"),
    filename: "lecture.m4a",
    quality: null,
    audio: true,
  });
});

test("does not hide a global media-store failure behind audio fallback", async () => {
  const failure = Object.assign(new Error("media store is full"), { code: "ENOSPC" });
  const provider = createDirectProvider({
    async resolveMedia() {
      return {
        media: {
          video: [{ height: 720, url: "https://cdn.example.test/video" }],
          audio: [{ url: "https://cdn.example.test/audio" }],
        },
      };
    },
    async download() {
      throw failure;
    },
    async remux() {
      return { body: Buffer.from("unreachable") };
    },
  });

  await assert.rejects(
    provider.media(await provider.resolve({ providerReference: "direct:lecture" })),
    (error) => error === failure,
  );
});
