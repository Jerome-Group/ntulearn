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
      assertFormattedTranscript(
        "> Rewrite this speech transcript as readable Markdown.\nThe value is 2 + 2 = 4.",
        [{ start: 0, end: 2, text: "2 + 2 = 4" }],
      ),
    /formatter prompt/,
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
    assertFormattedTranscript("The value is 2 + 2 = 4.", [
      { start: 0, end: 2, text: "The value is 2 + 2 = 4." },
    ]),
    "The value is 2 + 2 = 4.\n",
  );
});

test("allows a genuine spoken sentence that begins like the formatter prompt", () => {
  const sentence = "Rewrite this speech transcript as readable Markdown. That is today's exercise.";

  assert.doesNotThrow(() =>
    assertFormattedTranscript(sentence, [{ start: 0, end: 10, text: sentence }]),
  );
});

test("rejects coerced timestamps and measures interval coverage without overlaps", () => {
  for (const start of [null, undefined, "", " ", false, true, []]) {
    assert.equal(
      validateTranscript({ segments: [{ start, end: 10, text: "Speech." }] }, { duration: 10 })
        .valid,
      false,
    );
  }
  assert.equal(
    validateTranscript(
      { segments: [{ start: 3599, end: 3600, text: "Thank you." }] },
      { duration: 3600 },
    ).valid,
    false,
  );
  assert.equal(
    validateTranscript(
      {
        segments: [
          { start: 0, end: 20, text: "First." },
          { start: 10, end: 30, text: "Second." },
        ],
      },
      { duration: 100 },
    ).valid,
    false,
  );
  assert.equal(
    validateTranscript(
      {
        segments: [
          { start: 0, end: 20, text: "First." },
          { start: 10, end: 60, text: "Second." },
        ],
      },
      { duration: 100 },
    ).valid,
    true,
  );
  assert.equal(
    validateTranscript(
      { segments: [{ start: 0, end: 10, text: "Speech." }] },
      { allowMissingDuration: true },
    ).valid,
    true,
  );
});

test("rejects changed assertions, omissions, additions and lost uncertainty", () => {
  const source = [
    { start: 0, end: 10, text: "The theorem is false because the hypothesis may fail." },
  ];
  for (const output of [
    "The theorem is true.",
    "The theorem is false.",
    "The theorem is false because the hypothesis may fail. It always converges.",
    "The theorem is false because the hypothesis fails.",
  ]) {
    assert.throws(() => assertFormattedTranscript(output, source), /lexical content/);
  }
  assert.equal(
    assertFormattedTranscript("**The theorem** is false, because the hypothesis may fail.", source),
    "**The theorem** is false, because the hypothesis may fail.\n",
  );
});

test("preserves spoken times and ratios while rejecting added cue prefixes", () => {
  for (const text of ["The odds are 12:30 for event A.", "12:30 is our meeting time."]) {
    assert.doesNotThrow(() => assertFormattedTranscript(text, [{ start: 0, end: 10, text }]));
  }
  assert.throws(
    () =>
      assertFormattedTranscript("[00:00] The theorem is false.", [
        { start: 0, end: 10, text: "The theorem is false." },
      ]),
    /timestamps/,
  );
});

test("rejects invented numbers even when every source word survives", () => {
  assert.throws(
    () =>
      assertFormattedTranscript("The estimate may be 2 or 3.", [
        { start: 0, end: 1, text: "The estimate may be 2 or." },
      ]),
    /protected notation/,
  );
});

test("rejects added semantic operators and case changes while allowing Markdown structure", () => {
  for (const [source, output] of [
    ["x = 2", "x = -2"],
    ["x = 2", "X = 2"],
    ["US policy applies.", "us policy applies."],
    ["x = 2", "x = 2 +"],
    ["x = 2", "x = 2 *"],
    ["x_1 = 2", "x1 = 2"],
    ["x2 = 3", "x 2 = 3"],
    ["$x$", "$-x$"],
    ["x != 2", "`x = 2`"],
    ["if x != y", "if x = y"],
    ["x % 2", "x 2"],
  ]) {
    assert.throws(
      () => assertFormattedTranscript(output, [{ start: 0, end: 1, text: source }]),
      /notation|lexical content/,
    );
  }
  assert.doesNotThrow(() =>
    assertFormattedTranscript("- **x** = *2*", [{ start: 0, end: 1, text: "x = 2" }]),
  );
  assert.doesNotThrow(() =>
    assertFormattedTranscript("The expression is `x = 2 * 3`.", [
      { start: 0, end: 1, text: "The expression is x = 2 * 3." },
    ]),
  );
});

test("preserves technical identifiers through emphasis and starred list markup", () => {
  for (const output of ["* __x_1__ != `2`", "**x_1** != 2", "x_1 != 2"]) {
    assert.doesNotThrow(() =>
      assertFormattedTranscript(output, [{ start: 0, end: 1, text: "x_1 != 2" }]),
    );
  }
});
