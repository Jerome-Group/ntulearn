import assert from "node:assert/strict";
import test from "node:test";
import { capabilityResult, observation } from "../src/capabilities/result.mjs";

test("structured verdicts separate failure, blocked, passed and wholly unrun", () => {
  for (const [status, code] of [
    ["passed", 0],
    ["failed", 1],
    ["blocked", 2],
    ["unrun", 2],
  ]) {
    const result = capabilityResult("fixture", [
      observation("fixture", status, "FIXTURE", "fixture"),
    ]);
    assert.equal(result.status, status);
    assert.equal(result.exitCode, code);
  }
});
