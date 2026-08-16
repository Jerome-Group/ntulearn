import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFormattedTranscript,
  parseProviderTranscript,
  rawTranscriptJson,
  validateTranscript,
} from "../src/media/transcript.mjs";

test("parses and validates an ordered provider transcript with duration coverage", () => {
  const transcript = parseProviderTranscript({
    body: JSON.stringify({
      lang: "zh-SG",
      segments: [
        { startTime: "00:00:00.000", endTime: "00:00:03.000", text: "先看这个。" },
        { startTime: "3", endTime: "10", text: "Then we switch to English." },
      ],
    }),
  });
  const checked = validateTranscript(transcript, { duration: 10 });

  assert.equal(checked.valid, true);
  assert.equal(checked.transcript.language, "zh-SG");
  assert.deepEqual(checked.transcript.segments[0], { start: 0, end: 3, text: "先看这个。" });
  assert.match(rawTranscriptJson(checked.transcript), /"start": 0/);
});

test("rejects empty, unordered, and implausibly short provider transcripts", () => {
  assert.equal(validateTranscript({ language: "en", segments: [] }).valid, false);
  assert.match(
    validateTranscript({
      language: "en",
      segments: [
        { start: 2, end: 4, text: "later" },
        { start: 1, end: 3, text: "earlier" },
      ],
    }).reason,
    /not ordered/,
  );
  assert.match(
    validateTranscript(
      { language: "en", segments: [{ start: 0, end: 2, text: "short" }] },
      { duration: 100 },
    ).reason,
    /covers 2\.0s of 100\.0s/,
  );
  assert.match(
    validateTranscript({ language: "en", segments: [{ start: 0, end: 2, text: "speech" }] }).reason,
    /duration is unavailable/,
  );
});

test("accepts generated and explicit non-speech sources while rejecting duration overflow", () => {
  const generated = validateTranscript(
    {
      sourceKind: "generated",
      language: "en-SG",
      segments: [{ start: 0, end: 10, text: "The lecture is complete." }],
    },
    { duration: 10 },
  );
  assert.equal(generated.valid, true);
  assert.equal(generated.transcript.sourceKind, "generated");

  assert.match(
    validateTranscript(
      {
        sourceKind: "generated",
        language: "en",
        segments: [{ start: 0, end: 18, text: "This exceeds the recording." }],
      },
      { duration: 10 },
    ).reason,
    /extends beyond recording duration/,
  );

  const silent = validateTranscript(
    {
      sourceKind: "non-speech",
      language: "und",
      segments: [],
      reason: "music only",
    },
    { duration: 10 },
  );
  assert.equal(silent.valid, true);
  assert.equal(silent.transcript.sourceKind, "non-speech");
  assert.match(rawTranscriptJson(silent.transcript), /music only/);
  assert.match(
    validateTranscript({
      sourceKind: "non-speech",
      language: "und",
      segments: [{ start: 0, end: 1, text: "speech" }],
      reason: "music only",
    }).reason,
    /contains speech segments/,
  );
});

test("rejects formatting that keeps neither timestamps nor protected notation", () => {
  assert.throws(
    () =>
      assertFormattedTranscript("00:00 The value is 4.", [{ start: 0, end: 2, text: "2 + 2 = 4" }]),
    /timestamps/,
  );
  assert.throws(
    () =>
      assertFormattedTranscript("The value is four.", [{ start: 0, end: 2, text: "2 + 2 = 4" }]),
    /protected notation/,
  );
  assert.throws(
    () =>
      assertFormattedTranscript("The value is 4 = 2 + 2.", [
        { start: 0, end: 2, text: "2 + 2 = 4" },
      ]),
    /reorders protected notation/,
  );
  assert.throws(
    () =>
      assertFormattedTranscript("The theorem is true.", [
        { start: 0, end: 2, text: "这是 theorem." },
      ]),
    /code-switched text/,
  );
  assert.equal(
    assertFormattedTranscript("The value is 2 + 2 = 4.", [{ start: 0, end: 2, text: "2 + 2 = 4" }]),
    "The value is 2 + 2 = 4.\n",
  );
});
