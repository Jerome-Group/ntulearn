import assert from "node:assert/strict";
import test from "node:test";
import { assessRecoveryTranscript } from "../src/media/recovery-candidate.mjs";

const source = (text) => ({
  sourceKind: "generated",
  language: "en",
  segments: [{ start: 0, end: 20, text }],
});
test("native/normalized wording and timestamps pass without a reference; uncertainty remains", () => {
  const raw = source("Maybe x equals minus two 或者 three.");
  const result = assessRecoveryTranscript({
    native: raw,
    source: raw,
    duration: 20,
    id: "recording-1",
  });
  assert.equal(result.candidate.eligible, true);
  assert.equal(result.markdown.trim(), raw.segments[0].text);
  assert.equal(result.candidate.acousticVerification, "unrun");
  assert.equal(result.candidate.mediaReadiness, "unclaimed");
});
test("repetition remains in readable candidate and blocks publication", () => {
  const raw = source("loop ".repeat(50).trim());
  const result = assessRecoveryTranscript({
    native: raw,
    source: raw,
    duration: 20,
    id: "recording-1",
  });
  assert.equal(result.candidate.eligible, false);
  assert.deepEqual(result.candidate.flags, ["suspicious-repetition"]);
  assert.equal(result.markdown.trim(), raw.segments[0].text);
});
test("dropped malformed native segment and altered wording cannot become eligible", () => {
  const raw = source("Original words.");
  raw.segments.push({ start: 20, end: 10, text: "Uncertain words." });
  const result = assessRecoveryTranscript({
    native: raw,
    source: source("Original words."),
    duration: 20,
    id: "recording-1",
  });
  assert.equal(result.candidate.sourceStructure, "failed");
  assert.equal(result.candidate.eligible, false);
  const changed = assessRecoveryTranscript({
    native: source("Original words."),
    source: source("Corrected words."),
    duration: 20,
    id: "recording-1",
  });
  assert.equal(changed.candidate.sourceStructure, "failed");
});
test("banner/empty and impossible timing do not bless a candidate", () => {
  for (const text of ["", "return only the markdown transcript", "<html>access denied</html>"]) {
    const raw = source(text);
    const result = assessRecoveryTranscript({
      native: raw,
      source: raw,
      duration: 20,
      id: "recording-1",
    });
    assert.equal(result.candidate.eligible, false);
  }
  const raw = source("Finite words.");
  raw.segments[0].end = 40;
  assert.equal(
    assessRecoveryTranscript({ native: raw, source: raw, duration: 20, id: "recording-1" })
      .candidate.timing,
    "failed",
  );
});

test("nonspeech repetition and zero-duration annotation or lexical native rows stay review-only", () => {
  const repeated = source("[BLANK_AUDIO] ".repeat(12).trim());
  const assessed = assessRecoveryTranscript({
    native: repeated,
    source: repeated,
    duration: 20,
    id: "recording-1",
  });
  assert.equal(assessed.candidate.eligible, false);
  assert.deepEqual(assessed.candidate.flags, ["suspicious-repetition"]);
  assert.equal(assessed.markdown.trim(), repeated.segments[0].text);
  for (const text of ["[NON SPEECH]", "I."]) {
    const native = source("Let x equal minus two.");
    native.segments.push({ start: 20, end: 20, text });
    for (const parsed of [native, source("Let x equal minus two.")]) {
      const result = assessRecoveryTranscript({
        native,
        source: parsed,
        duration: 20,
        id: "recording-1",
      });
      assert.equal(result.candidate.eligible, false);
      assert.equal(result.candidate.timing, "failed");
      assert.equal(result.candidate.sourceStructure, "failed");
      assert.equal(result.markdown, null);
    }
  }
});
