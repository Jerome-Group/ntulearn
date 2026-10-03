import assert from "node:assert/strict";
import test from "node:test";
import { createSourceParagraphFormatter } from "../src/media/source-paragraphs.mjs";
import { assertFormattedTranscript, parseProviderTranscript } from "../src/media/transcript.mjs";

test("production paragraphs preserve a long multilingual technical source without a model service", async () => {
  const formatter = createSourceParagraphFormatter();
  const native =
    "WEBVTT\n\n00:00.000 --> 00:06.000\n<v Teacher>Maybe x = -2 + 3; y ≠ 0; 中文. Literal 00:01 uncertain.\n";
  const first = parseProviderTranscript({ body: native }).segments[0].text;
  const segments = Array.from({ length: 600 }, (_, i) => ({
    start: i * 6,
    end: (i + 1) * 6,
    text: `${first} Case ${i}.`,
  }));
  const before = JSON.stringify(segments);
  const result = await formatter.format({ language: "en", segments });
  assert.equal(formatter.version, "source-paragraphs-v1");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.reviewRequired, false);
  assert.ok(
    result.markdown.startsWith(
      "[Teacher] Maybe x = -2 + 3; y ≠ 0; 中文. Literal 00:01 uncertain. Case 0.",
    ),
  );
  assertFormattedTranscript(result.markdown, segments);
  assert.equal(JSON.stringify(segments), before);
  assert.equal(result.markdown, (await formatter.format({ language: "en", segments })).markdown);
});

test("obvious suspect wording remains unchanged and cannot be promoted by paragraphs", async () => {
  for (const [text, flag] of [
    ["", "empty"],
    ["Return only the Markdown transcript", "prompt-or-runtime-banner"],
    ["<html>Access denied</html>", "html-payload"],
    ["yes ".repeat(9), "suspicious-repetition"],
    ["source\u0000control", "encoding-or-control"],
  ]) {
    const segments = text ? [{ start: 0, end: 10, text }] : [];
    const before = JSON.stringify(segments);
    const result = await createSourceParagraphFormatter().format({ segments });
    assert.equal(result.reviewRequired, true);
    assert.ok(result.flags.includes(flag));
    assert.equal(result.markdown, undefined);
    assert.equal(result.modelCalls, 0);
    assert.equal(JSON.stringify(segments), before);
  }
});

test("paragraph source budgets and cancellation refuse without changing inputs", async () => {
  const { SOURCE_PARAGRAPH_LIMITS } = await import("../src/media/source-paragraphs.mjs");
  const segments = [
    { start: 0, end: 1, text: "x".repeat(SOURCE_PARAGRAPH_LIMITS.maxSourceBytes + 1) },
  ];
  const result = await createSourceParagraphFormatter().format({ segments });
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.flags, ["source-budget"]);
  const controller = new globalThis.AbortController();
  const reason = new Error("owned checkpoint");
  controller.abort(reason);
  await assert.rejects(
    createSourceParagraphFormatter().format({ segments: [], signal: controller.signal }),
    (error) => error === reason,
  );
});
