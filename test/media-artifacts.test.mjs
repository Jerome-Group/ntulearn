import assert from "node:assert/strict";
import test from "node:test";
import { createMediaArtifacts } from "../src/media/artifacts.mjs";
import { transcriptDigest } from "../src/media/transcript.mjs";

const appearance = {
  recordingId: "synthetic-recording",
  placement: { formattedTranscriptPath: "Lecture.transcript.md" },
};
const raw = JSON.stringify({
  sourceKind: "generated",
  language: "en",
  segments: [{ start: 0, end: 10, text: "The value is 4." }],
});
const formattedPath = "/synthetic/Lecture.transcript.md";
const formatted = "The value is 4. Student note.";
const proof = {
  recordingId: appearance.recordingId,
  sourceSha256: transcriptDigest(raw),
  formattedSha256: transcriptDigest(formatted),
  artifacts: { formattedTranscript: formattedPath },
};

function artifacts({ state = null, metadata = null } = {}) {
  const entries = new Map([
    ["raw-transcript", { path: "/synthetic/source.json", content: raw }],
    ["formatted-transcript", { path: formattedPath, content: formatted }],
    ...(state
      ? [["state", { path: "/synthetic/state.json", content: JSON.stringify(state) }]]
      : []),
    ...(metadata
      ? [["metadata", { path: "/synthetic/metadata.json", content: JSON.stringify(metadata) }]]
      : []),
  ]);
  return createMediaArtifacts({
    appearance,
    storage: { read: async ({ kind }) => entries.get(kind) ?? null },
  });
}

test("regeneration requires one coherent recording, source and derivative digest record", async () => {
  for (const evidence of [
    { state: { ...proof, formattedSha256: undefined } },
    { state: { ...proof, recordingId: "another-recording" } },
    { state: { ...proof, sourceSha256: transcriptDigest("old source") } },
    { state: { ...proof, formattedSha256: transcriptDigest("old derivative") } },
    { metadata: { ...proof, recordingId: "another-recording" } },
    {
      state: { ...proof, formattedSha256: undefined },
      metadata: { ...proof, sourceSha256: undefined },
    },
  ]) {
    const result = await artifacts(evidence).read({ regenerate: true });
    assert.equal(result.formattedReplacement, null);
    assert.equal(result.formattedRegenerationRequired, true);
  }
  for (const evidence of [{ state: proof }, { metadata: proof }]) {
    const result = await artifacts(evidence).read({ regenerate: true });
    assert.deepEqual(result.formattedReplacement, {
      path: formattedPath,
      sha256: proof.formattedSha256,
      sourceSha256: proof.sourceSha256,
    });
  }
});
