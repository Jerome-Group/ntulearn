import assert from "node:assert/strict";
import test from "node:test";
import { publicMediaError } from "../src/media/errors.mjs";

test("redacts provider launch parameters from relative diagnostics", () => {
  const message = publicMediaError(
    new Error(
      "launch_token=secret&state=csrf&cookie=session-cookie&token=another-secret&access_token=secret&sig=secret",
    ),
  );

  assert.equal(
    message,
    "launch_token=[redacted]&state=[redacted]&cookie=[redacted]&token=[redacted]&access_token=[redacted]&sig=[redacted]",
  );
  assert.doesNotMatch(message, /secret|csrf|session-cookie/);
});
