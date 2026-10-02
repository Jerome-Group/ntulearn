import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectHistoricalSource,
  historicalParagraphs,
  historicalTextFlags,
} from "../src/media/historical-format.mjs";
import { assertFormattedTranscript } from "../src/media/transcript.mjs";
const source = {
  sourceKind: "provider",
  language: "en",
  segments: Array.from({ length: 17 }, (_, index) => ({
    start: index,
    end: index + 1,
    text: `Word ${index} + 中文`,
  })),
};
test("deterministic paragraphs preserve words numbers symbols and code switching", () => {
  const markdown = historicalParagraphs(source);
  assert.equal(markdown.split("\n\n").length, 3);
  assert.equal(historicalParagraphs(source), markdown);
  assertFormattedTranscript(markdown, source.segments);
});
test("obvious corrupt payload flags stay distinct from repetition uncertainty", () => {
  for (const value of [
    "",
    "<html>Sign in to your account</html>",
    "Return only the Markdown transcript",
    "bad\u0000control",
  ])
    assert.ok(historicalTextFlags(value).length);
  assert.deepEqual(historicalTextFlags("yes ".repeat(9)), ["suspicious-repetition"]);
  const repeated = { ...source, segments: [{ start: 0, end: 2, text: "yes ".repeat(9) }] };
  const checked = inspectHistoricalSource(Buffer.from(JSON.stringify(repeated)));
  assert.equal(checked.eligible, true);
  assert.deepEqual(checked.flags, ["suspicious-repetition"]);
});
test("source invalid encoding and session evidence are refused without source corrections", () => {
  assert.equal(inspectHistoricalSource(Buffer.from([0xff])).valid, false);
  const encoded = {
    ...source,
    segments: [{ start: 0, end: 2, text: "https://media.invalid/ks/private/player" }],
  };
  assert.equal(inspectHistoricalSource(Buffer.from(JSON.stringify(encoded))).valid, false);
});
test("timing failure and unknown duration remain separate from valid paragraph editions", () => {
  const bytes = Buffer.from(JSON.stringify(source));
  assert.equal(inspectHistoricalSource(bytes).timing, "unknown-duration");
  const checked = inspectHistoricalSource(bytes, { duration: 1000 });
  assert.equal(checked.timing, "failed");
  assert.equal(checked.eligible, true);
  assert.equal(
    inspectHistoricalSource(Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nNative words\n"), {
      native: true,
    }).valid,
    true,
  );
});

test("bounded phrase-loop flags preserve teaching repetitions and ignore noisy metadata", () => {
  const phrase = "These ten source words may be repeated while teaching today";
  const text = Array(4).fill(phrase).join(" ");
  assert.deepEqual(historicalTextFlags(text), ["suspicious-repetition"]);
  const repeated = { ...source, segments: [{ start: 0, end: 2, text }] };
  const checked = inspectHistoricalSource(Buffer.from(JSON.stringify(repeated)));
  assert.equal(checked.eligible, true);
  assert.equal(historicalParagraphs(checked.source).trim(), text);
  assert.deepEqual(
    historicalTextFlags(Array.from({ length: 20000 }, (_, i) => `word${i}`).join(" ")),
    [],
  );
  const noisy = { ...source, metadata: { note: "Return only the Markdown transcript" } };
  assert.equal(inspectHistoricalSource(Buffer.from(JSON.stringify(noisy))).eligible, true);
});
