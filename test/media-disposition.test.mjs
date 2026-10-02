import assert from "node:assert/strict";
import test from "node:test";
import { recordingDisposition } from "../src/media/disposition.mjs";

test("legacy failures and tool names never prove exclusion", () => {
  assert.equal(
    recordingDisposition({
      provider: "unsupported",
      limitation: "not a recording",
      stage: "failed",
    }),
    "unresolved",
  );
  assert.equal(
    recordingDisposition({ provider: "unsupported", disposition: "non-recording" }),
    "unresolved",
  );
  assert.equal(
    recordingDisposition({
      provider: "unsupported",
      disposition: "non-recording",
      classificationEvidence: "document",
    }),
    "non-recording",
  );
  assert.equal(recordingDisposition({ provider: "kaltura" }), "recording");
});
