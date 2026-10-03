export const RECOVERY_POLICY = "independent-context-v1";
export const NONSPEECH_RECOVERY_POLICY = "independent-context-nonspeech-v1";
export const VAD_RECOVERY_POLICY = "independent-context-nonspeech-vad-v1";
export const RECOVERY_POLICIES = Object.freeze([
  RECOVERY_POLICY,
  NONSPEECH_RECOVERY_POLICY,
  VAD_RECOVERY_POLICY,
]);
import { VAD_CONTROLS } from "./vad-model.mjs";

export function asrPolicyArguments(policy, { vadModel } = {}) {
  if (policy === null) return [];
  if (!RECOVERY_POLICIES.includes(policy))
    throw new Error(
      "Unsupported ASR recovery policy. Use the indexed recovery policy and retry plan.",
    );
  return [
    "--max-context",
    "0",
    "--entropy-thold",
    "2.4",
    "--logprob-thold",
    "-1",
    "--no-speech-thold",
    "0.6",
    "--temperature",
    "0",
    "--temperature-inc",
    "0.2",
    ...(policy !== RECOVERY_POLICY ? ["--suppress-nst"] : []),
    ...(policy === VAD_RECOVERY_POLICY ? vadArguments(vadModel) : []),
  ];
}

function vadArguments(path) {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error("Prepared VAD model required. Run npm run media:setup -- vad.");
  return ["--vad", "--vad-model", path, ...VAD_CONTROLS];
}
