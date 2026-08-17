import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecordingCandidate } from "../src/media/classification.mjs";

test("classifies observed external shapes with stable redacted references", () => {
  const cases = [
    [
      "feedbackfruits",
      "FeedbackFruits",
      "https://app.feedbackfruits.com/activity/act-42?token=secret",
      "launch-link",
    ],
    [
      "cengage",
      "Cengage",
      "https://ng.cengage.com/activity/assignment-42?session=secret",
      "launch-link",
    ],
    [
      "blackboard",
      "Blackboard",
      "https://ntulearn.ntu.edu.sg/webapps/blackboard/execute/blti/launch?content_id=place-42&signature=secret",
      "launch-link",
    ],
    ["padlet", "Padlet", "https://padlet.com/course/lecture-42?token=secret", "embedded-player"],
    [
      "turnitin",
      "Turnitin",
      "https://www.turnitin.com/assignment/42?launch_token=secret",
      "launch-link",
    ],
  ];

  for (const [provider, providerName, value, sourceKind] of cases) {
    const result = classifyRecordingCandidate({ value, sourceKind });
    assert.equal(result.provider, "unsupported");
    assert.equal(result.providerName, providerName);
    assert.equal(result.providerShape, provider);
    assert.equal(result.retryable, true);
    assert.match(result.providerReference, new RegExp(`^unsupported:${provider}:`));
    assert.doesNotMatch(JSON.stringify(result), /https?:\/\//);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test("does not turn an ordinary external tool link into a recording", () => {
  assert.equal(
    classifyRecordingCandidate({
      value: "https://www.turnitin.com/help/article-42",
      sourceKind: "external-link",
    }),
    null,
  );
});

test("keeps an opaque unsupported reference stable without serializing its value", () => {
  const value = { providerPayload: { launchToken: "secret", fields: ["opaque"] } };
  const first = classifyRecordingCandidate({ value, sourceKind: "embedded-player" });
  const second = classifyRecordingCandidate({ value, sourceKind: "embedded-player" });

  assert.equal(first.provider, "unsupported");
  assert.equal(first.providerReference, second.providerReference);
  assert.match(first.providerReference, /^unsupported:opaque:/);
  assert.doesNotMatch(JSON.stringify(first), /secret|providerPayload|launchToken/);

  const sameSecrets = classifyRecordingCandidate({
    value: { providerPayload: { launchToken: "different", fields: ["opaque"] } },
    sourceKind: "embedded-player",
  });
  assert.equal(first.providerReference, sameSecrets.providerReference);

  const different = classifyRecordingCandidate({
    value: { providerPayload: { launchToken: "different", fields: ["changed"] } },
    sourceKind: "embedded-player",
  });
  assert.notEqual(first.providerReference, different.providerReference);
});

test("keeps NTULearn file-shaped non-media references retryable without saving their address", () => {
  const result = classifyRecordingCandidate({
    value: {
      resourceUrl: "/bbcswebdav/readings/week-1.pdf?signature=secret",
      fileName: "week-1.pdf",
      mimeType: "application/pdf",
    },
    sourceKind: "attachment",
  });

  assert.equal(result.provider, "unsupported");
  assert.equal(result.providerName, "NTULearn file");
  assert.equal(result.providerShape, "ntulearn-file");
  assert.equal(result.retryable, true);
  assert.match(result.providerReference, /^unsupported:ntulearn/);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|signature=secret/);
});

test("unsupported malformed links use a redacted stable shape reference", () => {
  const result = classifyRecordingCandidate({
    value: "not a URL?token=secret&launch=opaque",
    sourceKind: "launch-link",
  });

  assert.match(result.providerReference, /^unsupported:opaque:/);
  assert.doesNotMatch(JSON.stringify(result), /secret|launch=opaque|not a URL/);
});

test("accepts a safe direct media field inside an opaque provider object", () => {
  const result = classifyRecordingCandidate({
    value: {
      provider: "Padlet",
      videoUrl: "https://cdn.example.test/lecture.mp4?signature=secret",
    },
    sourceKind: "embedded-player",
  });

  assert.deepEqual(result, {
    provider: "direct",
    providerReference: "direct:cdn.example.test/lecture.mp4",
    mediaType: "video",
  });
});
