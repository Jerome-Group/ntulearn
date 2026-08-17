import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createExternalShapeAdapter, providerForRecording } from "../src/media/external.mjs";

test("a provider adapter exposes one stable discovery and acquisition seam", async () => {
  const adapter = createExternalShapeAdapter({
    provider: "fixture-media",
    matches: ({ value }) => value?.fixture === true,
    referenceOf: () => "fixture-media:id:lecture-1",
    resolve: async ({ reference, fresh }) => ({ reference, fresh, duration: 2 }),
    transcript: async (resolved) => ({
      body: JSON.stringify({
        language: "en",
        segments: [{ start: 0, end: resolved.duration, text: "Hello." }],
      }),
    }),
    media: async () => ({ kind: "audio", body: Buffer.from("audio"), filename: "lecture.m4a" }),
  });

  const classification = adapter.classify({
    value: { fixture: true, launchUrl: "https://fixture.example.test/launch?token=secret" },
    sourceKind: "launch-link",
  });
  assert.deepEqual(classification, {
    provider: "fixture-media",
    providerName: "fixture-media",
    providerShape: "fixture-media",
    providerReference: "fixture-media:id:lecture-1",
  });

  const provider = adapter.createProvider();
  const resolved = await provider.resolve({ providerReference: classification.providerReference });
  assert.deepEqual(resolved, {
    reference: "fixture-media:id:lecture-1",
    fresh: true,
    duration: 2,
  });
  assert.equal((await provider.transcript(resolved)).body.includes("Hello"), true);
  assert.deepEqual((await provider.media(resolved)).body, Buffer.from("audio"));
});

test("selects the production adapter for a classified appearance", async () => {
  const provider = providerForRecording({
    appearance: { provider: "unsupported", providerShape: "feedbackfruits" },
  });

  assert.equal(provider.name, "feedbackfruits");
  assert.deepEqual(await provider.media(null), {
    kind: "unavailable",
    limitation:
      "FeedbackFruits content is visible but its recording acquisition path is unavailable.",
    retryable: true,
  });
});

test("redacts a provider adapter that accidentally returns a launch URL", () => {
  const adapter = createExternalShapeAdapter({
    provider: "fixture-media",
    matches: () => true,
    referenceOf: () => "https://fixture.example.test/lecture?token=secret",
  });

  const result = adapter.classify({ value: "fixture", sourceKind: "embedded-player" });
  assert.match(result.providerReference, /^fixture-media:fixture\.example\.test\/lecture$/);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|secret/);
});

test("redacts ephemeral fields from a custom provider reference", () => {
  const adapter = createExternalShapeAdapter({
    provider: "fixture-media",
    matches: () => true,
    referenceOf: () => "state=secret&access_token=secret&sig=secret",
  });

  const result = adapter.classify({ value: "fixture", sourceKind: "launch-link" });
  assert.match(result.providerReference, /^fixture-media:opaque:/);
  assert.doesNotMatch(JSON.stringify(result), /state=secret|access_token=secret|sig=secret/);
});
