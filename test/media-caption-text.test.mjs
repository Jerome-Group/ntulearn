import assert from "node:assert/strict";
import test from "node:test";
import { captionText } from "../src/media/caption-text.mjs";

test("normalization decodes entities once and preserves literal unknown entities", () => {
  assert.equal(
    captionText("<v A &amp;lt; B>&amp;lt; &unknown; &#x3B1;</v>"),
    "[A &lt; B] &lt; &unknown; α",
  );
});

test("VTT decodes entities and internal timestamps without deleting literal mathematics", () => {
  assert.equal(
    captionText("<v A>α &lt; 2 &amp; x < 3 <00:02.000> [unclear]</v> <v B>&#946; &gt; 0</v>"),
    "[A] α < 2 & x < 3 [unclear] [B] β > 0",
  );
  assert.throws(() => captionText("<unknown>words</unknown>"), /unsupported.*markup/i);
  assert.throws(() => captionText("<i>words</b>"), /malformed.*markup/i);
});
