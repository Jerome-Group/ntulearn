import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanLocalFormatterOutput,
  createLocalFormatter,
  LOCAL_FORMATTING_RULES,
} from "../src/media/formatter.mjs";

test("removes echoed prompts from every local formatter response", () => {
  const prompt = "Rewrite this speech transcript as readable Markdown.\nTranscript:\nraw chunk";
  const echoed = `> ${prompt}`;

  assert.equal(
    cleanLocalFormatterOutput(
      `llama.cpp startup banner\n${echoed}\nReadable one.\n${echoed}\nReadable two.`,
      prompt,
    ),
    "Readable one.\n\nReadable two.",
  );
});

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
  assert.match(calls[0].prompt, /^Rewrite this speech transcript as readable Markdown\./);
  assert.equal(result.markdown, "one two\n\nthree");
});

test("cleans the local model prompt before returning formatted Markdown", async () => {
  const formatter = createLocalFormatter({
    version: "local-model-1",
    model: {
      async generate({ prompt }) {
        return `llama.cpp startup banner\n> ${prompt}\nReadable transcript.`;
      },
    },
  });

  const result = await formatter.format({
    appearance: { recordingId: "recording-1" },
    language: "en",
    segments: [{ start: 0, end: 1, text: "raw transcript" }],
  });

  assert.equal(result.markdown, "Readable transcript.");
});

test("unwraps a complete Markdown fence but preserves a code fence in later prose", () => {
  assert.equal(
    cleanLocalFormatterOutput("```markdown\nReadable transcript.\n```"),
    "Readable transcript.",
  );

  const transcript = "```\nconst value = 2;\n```\nThe lecturer explains the code afterward.";
  assert.equal(cleanLocalFormatterOutput(transcript), transcript);
});

test("starts a new chunk when timestamps exceed the duration bound", async () => {
  const calls = [];
  const formatter = createLocalFormatter({
    version: "local-model-1",
    maxSegments: 10,
    maxDuration: 2,
    model: {
      async generate(input) {
        calls.push(input);
        return { markdown: input.text };
      },
    },
  });

  await formatter.format({
    appearance: { recordingId: "recording-1" },
    language: "en",
    segments: [
      { start: 0, end: 1, text: "one" },
      { start: 1, end: 2, text: "two" },
      { start: 2, end: 3, text: "three" },
    ],
  });

  assert.deepEqual(
    calls.map(({ text }) => text),
    ["one two", "three"],
  );
});

test("rejects a single segment that exceeds the duration bound", async () => {
  const formatter = createLocalFormatter({
    version: "local-model-1",
    maxDuration: 2,
    model: {
      async generate() {
        return { markdown: "unused" };
      },
    },
  });

  await assert.rejects(
    formatter.format({
      appearance: { recordingId: "recording-1" },
      language: "en",
      segments: [{ start: 0, end: 3, text: "too long" }],
    }),
    /longer than maxDuration/,
  );
});
