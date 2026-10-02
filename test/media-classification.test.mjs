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

test("excludes positively identified NTULearn documents without saving their address", () => {
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
  assert.equal(result.retryable, false);
  assert.equal(result.disposition, "non-recording");
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
    disposition: "recording",
    classificationEvidence: "media",
    identityReference: "direct:cdn.example.test/lecture.mp4",
    candidateReference: "candidate:cdn.example.test/lecture.mp4",
  });
});

test("requires positive resource evidence and recognizes bounded nested media", () => {
  const cases = [
    [
      {
        file: {
          resourceUrl: "/bbcswebdav/lecture.mp4",
          fileName: "lecture.mp4",
          mimeType: "video/mp4",
        },
      },
      "recording",
      "direct",
    ],
    [
      { resourceUrl: "/bbcswebdav/slides", fileName: "slides.pdf", mimeType: "application/pdf" },
      "non-recording",
      "unsupported",
    ],
    [{ resourceUrl: "/bbcswebdav/opaque", uploadId: "fixture" }, "unresolved", "unsupported"],
    [
      { resourceUrl: "/bbcswebdav/conflict.mp4", mimeType: "application/pdf" },
      "unresolved",
      "unsupported",
    ],
    [
      { file: { resourceUrl: "/bbcswebdav/lecture", mimeType: "audio/mp4" } },
      "recording",
      "direct",
    ],
    [
      {
        files: [
          { resourceUrl: "/doc.pdf", mimeType: "application/pdf" },
          { resourceUrl: "/video.mp4", mimeType: "video/mp4" },
        ],
      },
      "unresolved",
      "unsupported",
    ],
  ];
  for (const [value, disposition, provider] of cases) {
    const result = classifyRecordingCandidate({ value, sourceKind: "attachment" });
    assert.equal(result.disposition, disposition);
    assert.equal(result.provider, provider);
    assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|mimeType|resourceUrl/);
  }
  assert.equal(
    classifyRecordingCandidate({
      value: "https://padlet.com/fixture",
      sourceKind: "embedded-player",
    }).disposition,
    "unresolved",
  );
});

test("positive media without an acquisition reference remains an unsupported recording", () => {
  const result = classifyRecordingCandidate({
    value: { uploadId: "fixture", mimeType: "video/mp4" },
    sourceKind: "attachment",
  });
  assert.equal(result.disposition, "recording");
  assert.equal(result.provider, "unsupported");
});

test("cycles and traversal overflow remain bounded and unresolved", () => {
  const value = { file: { resourceUrl: "/doc.pdf", mimeType: "application/pdf" } };
  value.file.file = value;
  assert.equal(
    classifyRecordingCandidate({ value, sourceKind: "attachment" }).disposition,
    "unresolved",
  );
  const wide = {
    files: Array.from({ length: 80 }, (_, id) => ({
      id: String(id),
      resourceUrl: "/doc.pdf",
      mimeType: "application/pdf",
    })),
  };
  assert.equal(
    classifyRecordingCandidate({ value: wide, sourceKind: "attachment" }).disposition,
    "unresolved",
  );
});

test("conflicting nested recordings and non-document MIME families remain unresolved", () => {
  const values = [
    { files: [{ url: "/first.mp4" }, { url: "/second.mp4" }] },
    { resourceUrl: "/opaque", mimeType: "application/vnd.ms-wpl" },
    { resourceUrl: "/opaque", mimeType: "application/octet-stream" },
  ];
  for (const value of values)
    assert.equal(
      classifyRecordingCandidate({ value, sourceKind: "attachment" }).disposition,
      "unresolved",
    );
  assert.equal(
    classifyRecordingCandidate({
      value: {
        resourceUrl: "/opaque",
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      sourceKind: "attachment",
    }).disposition,
    "non-recording",
  );
});

test("tool titles resembling documents never prove a resource exclusion", () => {
  for (const key of ["name", "displayName", "linkName"]) {
    const result = classifyRecordingCandidate({
      value: { url: "https://padlet.com/opaque", [key]: "slides.pdf" },
      sourceKind: "embedded-player",
    });
    assert.equal(result.disposition, "unresolved");
  }
});

test("distinct nested string recording references stay unresolved across providers", () => {
  for (const resources of [
    ["https://example.test/a.mp4", "https://example.test/b.mp4"],
    ["https://youtu.be/fixtureA", "https://example.test/b.mp4"],
    ["https://example.test/a.mp4", { resourceUrl: "https://example.test/b.mp4" }],
  ]) {
    const result = classifyRecordingCandidate({ value: { resources }, sourceKind: "attachment" });
    assert.equal(result.disposition, "unresolved");
    assert.equal(result.provider, "unsupported");
  }
  const repeated = classifyRecordingCandidate({
    value: { resources: ["https://example.test/a.mp4", "https://example.test/a.mp4"] },
    sourceKind: "attachment",
  });
  assert.equal(repeated.disposition, "recording");
  assert.equal(repeated.provider, "direct");
});

test("nested document addresses conflict with recordings while title strings remain opaque", () => {
  for (const [resources, disposition] of [
    [["https://example.test/slides.pdf", "https://example.test/b.mp4"], "unresolved"],
    [["https://example.test/slides.pdf?private=fixture"], "non-recording"],
    [["/documents/slides.pdf"], "non-recording"],
    [["slides.pdf"], "unresolved"],
  ]) {
    const result = classifyRecordingCandidate({ value: { resources }, sourceKind: "attachment" });
    assert.equal(result.disposition, disposition);
    assert.doesNotMatch(JSON.stringify(result), /private=fixture|https?:\/\//);
  }
});

test("distinct provider IDs in one descriptor conflict while alternate same-ID URLs remain usable", () => {
  for (const value of [
    { url: "https://youtu.be/fixtureA", resourceUrl: "https://youtu.be/fixtureB" },
    {
      url: "https://media.test/index.php/extwidget/preview/entry_id/0_first",
      resourceUrl: "https://media.test/index.php/extwidget/preview/entry_id/0_second",
    },
  ])
    assert.equal(
      classifyRecordingCandidate({ value, sourceKind: "attachment" }).disposition,
      "unresolved",
    );
  const same = classifyRecordingCandidate({
    value: {
      url: "https://youtu.be/fixtureA",
      resourceUrl: "https://youtube.com/watch?v=fixtureA",
    },
    sourceKind: "attachment",
  });
  assert.equal(same.disposition, "recording");
  assert.equal(same.providerReference, "youtube:fixtureA");
  for (const value of [
    {
      url: "https://media.test/index.php/extwidget/preview/entry_id/0_first",
      resourceUrl: "https://media.test/download.mp4?entry_id=0_first",
    },
    { url: "https://youtu.be/fixtureA", resourceUrl: "https://example.test/download.mp4" },
  ])
    assert.equal(
      classifyRecordingCandidate({ value, sourceKind: "attachment" }).disposition,
      "recording",
    );
});
