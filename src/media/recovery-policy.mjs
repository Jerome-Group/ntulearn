export const RECOVERY_POLICY = "independent-context-v1";
export const NONSPEECH_RECOVERY_POLICY = "independent-context-nonspeech-v1";
export const RECOVERY_POLICIES = Object.freeze([RECOVERY_POLICY, NONSPEECH_RECOVERY_POLICY]);

export function asrPolicyArguments(policy) {
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
    ...(policy === NONSPEECH_RECOVERY_POLICY ? ["--suppress-nst"] : []),
  ];
}
