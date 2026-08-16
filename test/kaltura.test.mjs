import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  chooseRepresentation,
  createKalturaProvider,
  kalturaReferenceOf,
} from "../src/media/kaltura.mjs";

test("keeps one safe Kaltura reference per entry and chooses 720p", () => {
  assert.equal(
    kalturaReferenceOf("https://video.example.test/embed/entry_id/abc?ks=expiring"),
    "entry:abc",
  );
  assert.equal(kalturaReferenceOf({ entryId: "object-entry?ks=secret" }), "entry:object-entry");
  assert.equal(kalturaReferenceOf("/kaltura/entry_id/relative-entry"), "entry:relative-entry");
  assert.equal(kalturaReferenceOf({ entryId: "object-entry" }), "entry:object-entry");
  assert.equal(
    kalturaReferenceOf("https://media.example.test/kaltura/player/lecture"),
    "path:media.example.test/kaltura/player/lecture",
  );
  assert.equal(kalturaReferenceOf("https://media.example.test/player/video"), null);

  const selected = chooseRepresentation([
    { height: 1080, url: "https://video.test/1080" },
    { height: 720, url: "https://video.test/720" },
    { height: 480, url: "https://video.test/480" },
  ]);
  assert.equal(selected.height, 720);
});

test("resolves fresh playback data and remuxes without re-encoding", async () => {
  const calls = [];
  const provider = createKalturaProvider({
    async resolveEntry(value) {
      calls.push(["resolve", value]);
      return {
        media: {
          video: [
            { height: 1080, url: "https://video.test/1080?ks=secret" },
            { height: 720, url: "https://video.test/720?ks=secret" },
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

  const appearance = { providerReference: "entry:abc" };
  const resolved = await provider.resolve(appearance);
  const media = await provider.media(resolved);

  assert.deepEqual(calls[0], ["resolve", { reference: "entry:abc", fresh: true }]);
  assert.deepEqual(calls[1], ["download", "https://video.test/720?ks=secret", { fresh: true }]);
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

test("aborts a hanging media download at the queue checkpoint", async () => {
  const controller = new globalThis.AbortController();
  let downloadOptions;
  let remuxCalled = false;
  const provider = createKalturaProvider({
    async resolveEntry() {
      return null;
    },
    async download(_url, options) {
      downloadOptions = options;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
    async remux() {
      remuxCalled = true;
      return { body: Buffer.from("unreachable") };
    },
  });
  const pending = provider.media(
    {
      media: { video: [{ height: 720, url: "https://video.test/720" }] },
    },
    { signal: controller.signal },
  );
  const checkpoint = new Error("04:00 checkpoint");
  checkpoint.code = "MEDIA_CHECKPOINT";
  controller.abort(checkpoint);

  await assert.rejects(pending, (error) => error === checkpoint);
  assert.equal(downloadOptions.signal, controller.signal);
  assert.equal(remuxCalled, false);
});
