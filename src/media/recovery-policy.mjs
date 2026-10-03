export const RECOVERY_POLICY = "independent-context-v1";

export function asrPolicyArguments(policy) {
  if (policy === null) return [];
  if (policy !== RECOVERY_POLICY)
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
  ];
}
