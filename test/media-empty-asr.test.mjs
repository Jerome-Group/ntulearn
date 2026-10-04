import assert from "node:assert/strict";
import test from "node:test";
import { isRecognizedEmptyNative } from "../src/media/empty-asr.mjs";

test("explicit empty native evidence is safe and never infers silence", () => {
  assert.equal(isRecognizedEmptyNative({ transcription: [] }), true);
  assert.equal(isRecognizedEmptyNative({ segments: [] }), true);
  assert.equal(isRecognizedEmptyNative({ transcription: [], segments: [] }), true);
  assert.equal(isRecognizedEmptyNative({ transcription: [], segments: [{}] }), false);
  assert.equal(isRecognizedEmptyNative({}), false);
  for (const native of [
    { transcription: null, segments: [] },
    { transcription: [], segments: null },
    { transcription: [], segments: {} },
    { transcription: {}, segments: [] },
  ])
    assert.equal(isRecognizedEmptyNative(native), false);
  assert.throws(() => isRecognizedEmptyNative({ transcription: [], metadata: "?token=fixture" }));
});

test("empty admission never executes array getters or hides metadata behind body wrappers", () => {
  let read = false;
  assert.equal(
    isRecognizedEmptyNative({
      get transcription() {
        read = true;
        return [];
      },
    }),
    false,
  );
  assert.equal(read, false);
  assert.throws(() =>
    isRecognizedEmptyNative({ transcription: [], body: "fixture", metadata: "?token=fixture" }),
  );
});
