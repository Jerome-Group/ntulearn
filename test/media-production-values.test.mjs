import assert from "node:assert/strict";
import test from "node:test";
import {
  directSourceFor,
  mediaExtension,
  mediaManifestUrl,
  mediaTime,
  transcriptSegmentTime,
} from "../src/media/production-values.mjs";

test("resolves a synced direct attachment without persisting its provider URL", () => {
  assert.deepEqual(
    directSourceFor({
      courseKey: "AB1001",
      mediaType: "video",
      providerReference: "direct:file:lecture.mp4",
      placement: {
        destination: "/course",
        videoPath: "01 Lecture.mp4",
        videoAlreadyPresent: true,
      },
    }),
    { kind: "video", path: "/course/01 Lecture.mp4", local: true },
  );
});

test("reconstructs a stable direct browser address and rejects a file-only reference", () => {
  assert.equal(
    directSourceFor({
      mediaType: "audio",
      providerReference: "direct:ntulearn.ntu.edu.sg/session/lecture.mp3",
    }).address,
    "https://ntulearn.ntu.edu.sg/session/lecture.mp3",
  );
  assert.equal(
    directSourceFor({
      mediaType: "video",
      providerReference: "direct:cdn.test/Lecture%201%20%E6%95%B0%E5%AD%A6.mp4",
    }).address,
    "https://cdn.test/Lecture%201%20%E6%95%B0%E5%AD%A6.mp4",
  );
  assert.throws(
    () =>
      directSourceFor({
        courseKey: "AB1001",
        providerReference: "direct:file:lecture.mp4",
      }),
    /npm run media:discover -- AB1001/,
  );
});

test("rejects a retained direct path outside its course destination", () => {
  assert.throws(
    () =>
      directSourceFor({
        courseKey: "AB1001",
        mediaType: "video",
        placement: {
          destination: "/course",
          videoPath: "../escape.mp4",
          videoAlreadyPresent: true,
        },
      }),
    /escapes.*npm run media:discover -- AB1001/,
  );
});

test("normalizes provider manifests, durations, transcript offsets, and media extensions", () => {
  assert.equal(
    mediaManifestUrl(['{"url":"https:\\/\\/cdn.test\\/master.m3u8"}']),
    "https://cdn.test/master.m3u8",
  );
  assert.equal(mediaTime("01:02:03"), 3723);
  assert.equal(transcriptSegmentTime({ offsets: { from: 2500 } }, "from", "start"), 2.5);
  assert.equal(mediaExtension({ contentType: "audio/mpeg", kind: "audio" }), ".mp3");
});
