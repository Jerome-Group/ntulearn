import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createLocalTranscriber, evaluateAsrModels } from "../src/media/asr.mjs";

test("local transcriber keeps the ASR adapter replaceable and preserves declared language", async () => {
  const transcriber = createLocalTranscriber({
    version: "whisper-small.en-r1",
    modelMetadata: {
      name: "small.en",
      revision: "r1",
      sha256: "a".repeat(64),
      license: "MIT",
    },
    model: {
      async transcribe({ media }) {
        assert.equal(media.kind, "audio");
        assert.deepEqual(media.body, Buffer.from("audio"));
        return {
          language: "zh-SG",
          segments: [{ start: 0, end: 4, text: "先看这个。" }],
        };
      },
    },
  });

  const result = await transcriber.transcribe({
    appearance: { recordingId: "recording-1" },
    media: { kind: "audio", body: Buffer.from("audio") },
    duration: 4,
  });

  assert.deepEqual(result, {
    sourceKind: "generated",
    language: "zh-SG",
    segments: [{ start: 0, end: 4, text: "先看这个。" }],
  });
  assert.equal(transcriber.runtimeMetadata.selectedModel.name, "small.en");
});

test("ASR evaluation compares the three candidate models and selects the smallest sufficient one", async () => {
  const result = await evaluateAsrModels({
    candidates: [
      { name: "small.en", revision: "r1", sha256: "a".repeat(64), license: "MIT" },
      { name: "medium.en", revision: "r2", sha256: "b".repeat(64), license: "MIT" },
      { name: "large-v3-turbo", revision: "r3", sha256: "c".repeat(64), license: "MIT" },
    ],
    fixtures: ["representative-lecture"],
    async measure({ candidate }) {
      return {
        courseTerm: candidate.name === "small.en" ? 0.96 : 0.98,
        mathematicalUtterance: candidate.name === "small.en" ? 0.72 : 0.95,
        timestamp: candidate.name === "large-v3-turbo" ? 0.98 : 0.94,
        throughput: candidate.name === "large-v3-turbo" ? 0.7 : 1.2,
      };
    },
  });

  assert.deepEqual(
    result.candidates.map(({ model }) => model.name),
    ["small.en", "medium.en", "large-v3-turbo"],
  );
  assert.equal(result.selectedModel.name, "medium.en");
  assert.match(result.selectionReason, /smallest model/i);
  assert.equal(
    result.candidates.find(({ model }) => model.name === "small.en").meetsRequirements,
    false,
  );
  assert.equal(
    result.candidates.find(({ model }) => model.name === "medium.en").meetsRequirements,
    true,
  );

  const transcriber = createLocalTranscriber({
    version: "whisper-medium.en-r2",
    modelMetadata: result.selectedModel,
    evaluation: result,
    model: {
      async transcribe() {
        return { language: "en", segments: [] };
      },
    },
  });
  assert.equal(transcriber.runtimeMetadata.evaluation.selectedModel.name, "medium.en");
});

test("local transcriber preserves an explicit non-speech result", async () => {
  const transcriber = createLocalTranscriber({
    version: "whisper-small.en-r1",
    modelMetadata: {
      name: "small.en",
      revision: "r1",
      sha256: "a".repeat(64),
      license: "MIT",
    },
    model: {
      async transcribe() {
        return { sourceKind: "non-speech", language: "und", reason: "music only" };
      },
    },
  });

  assert.deepEqual(
    await transcriber.transcribe({ media: { kind: "audio", body: Buffer.from("music") } }),
    { sourceKind: "non-speech", language: "und", segments: [], reason: "music only" },
  );
});
