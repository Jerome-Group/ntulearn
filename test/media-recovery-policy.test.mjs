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

test("nonspeech recovery extends only the explicit independent-context decoder policy", () => {
  const original = asrPolicyArguments(RECOVERY_POLICY);
  assert.equal(original.includes("--suppress-nst"), false);
  assert.deepEqual(asrPolicyArguments("independent-context-nonspeech-v1"), [
    ...original,
    "--suppress-nst",
  ]);
  for (const unknown of [undefined, "independent-context-nonspeech-v2", "", {}, ["--suppress-nst"]])
    assert.throws(() => asrPolicyArguments(unknown), /indexed recovery policy/);
});

test("VAD controls are closed and need an admitted model; preceding policies remain unchanged", () => {
  const policy = "independent-context-nonspeech-vad-v1";
  assert.throws(() => asrPolicyArguments(policy), /Prepared VAD model required/);
  assert.throws(() => asrPolicyArguments(policy, { vadModel: "relative.bin" }));
  const args = asrPolicyArguments(policy, { vadModel: "/synthetic/model.bin" });
  assert.deepEqual(
    args.slice(0, asrPolicyArguments("independent-context-nonspeech-v1").length),
    asrPolicyArguments("independent-context-nonspeech-v1"),
  );
  assert.equal(args[args.indexOf("--vad-model") + 1], "/synthetic/model.bin");
  assert.equal(args[args.indexOf("--vad-threshold") + 1], "0.5");
  assert.equal(args[args.indexOf("--vad-min-speech-duration-ms") + 1], "250");
  assert.equal(args[args.indexOf("--vad-min-silence-duration-ms") + 1], "100");
  assert.equal(args[args.indexOf("--vad-speech-pad-ms") + 1], "30");
  assert.equal(args[args.indexOf("--vad-samples-overlap") + 1], "0.1");
  assert.equal(args[args.indexOf("--processors") + 1], "1");
});
