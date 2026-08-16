import assert from "node:assert/strict";
import test from "node:test";
import { createLocalFormatter, LOCAL_FORMATTING_RULES } from "../src/media/formatter.mjs";

test("formats bounded timestamp-derived chunks sequentially through the local model adapter", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const formatter = createLocalFormatter({
    version: "local-model-1",
    maxSegments: 2,
    model: {
      async generate(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push(input);
        await Promise.resolve();
        active -= 1;
        return { markdown: input.text, limitations: [] };
      },
    },
  });

  const result = await formatter.format({
    appearance: { recordingId: "recording-1" },
    language: "en",
    segments: [
      { start: 0, end: 1, text: "one" },
      { start: 1, end: 2, text: "two" },
      { start: 2, end: 3, text: "three" },
    ],
  });

  assert.equal(formatter.version, "local-model-1");
  assert.equal(maximumActive, 1);
  assert.deepEqual(
    calls.map(({ text }) => text),
    ["one two", "three"],
  );
  assert.deepEqual(calls[0].instructions, LOCAL_FORMATTING_RULES);
  assert.equal(result.markdown, "one two\n\nthree");
});
