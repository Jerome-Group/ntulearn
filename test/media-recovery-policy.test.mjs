import assert from "node:assert/strict";
import test from "node:test";
import { asrPolicyArguments, RECOVERY_POLICY } from "../src/media/recovery-policy.mjs";

test("ordinary production preserves its defaults; recovery permits only an explicit pinned context policy", () => {
  assert.deepEqual(asrPolicyArguments(null), []);
  const args = asrPolicyArguments(RECOVERY_POLICY);
  assert.equal(args[args.indexOf("--max-context") + 1], "0");
  assert.equal(args[args.indexOf("--no-speech-thold") + 1], "0.6");
  assert.equal(args.includes("--no-fallback"), false);
  assert.equal(args.includes("--vad"), false);
  assert.throws(() => asrPolicyArguments(["--suppress-regex", ".*"]), /indexed recovery policy/);
});
