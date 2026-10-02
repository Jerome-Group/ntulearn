import assert from "node:assert/strict";
import test from "node:test";
import { referenceAlignment } from "../src/media/evaluation-alignment.mjs";

test("declared reference alignment detects missing and unmatched words without proving hallucinations", () => {
  const reference = {
    kind: "generated-script",
    text: "Let x equal minus two. Do not change the sign.",
  };
  const exact = referenceAlignment(reference, "Let X equal minus 2. Do not change the sign.");
  assert.equal(exact.conditionalWer, 0);
  const changed = referenceAlignment(
    reference,
    "x equal minus two. Do not change the sign. invented banana explanation",
  );
  assert.equal(changed.deletions, 1);
  assert.equal(changed.insertions, 3);
  assert.equal(changed.hallucinationsConfirmed, false);
  assert.match(changed.interpretation, /conditional/);
  assert.equal(referenceAlignment({ kind: "unavailable" }, "words"), null);
});

test("long repeated inputs remain bounded and annotation accuracy stays unverified", () => {
  const text = "The eigenvalue may be zero. ".repeat(100);
  assert.equal(referenceAlignment({ kind: "annotated-audio", text }, text).conditionalWer, 0);
  assert.match(
    referenceAlignment({ kind: "annotated-audio", text: "a" }, "a").interpretation,
    /accuracy unverified/,
  );
  assert.throws(
    () =>
      referenceAlignment(
        { kind: "generated-script", text: "word ".repeat(15000) },
        "word ".repeat(15000),
      ),
    /bounded token budget/,
  );
});
