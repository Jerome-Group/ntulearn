import { join } from "node:path";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";
import { assessRecoveryTranscript } from "./recovery-candidate.mjs";

// Both resume and publication derive eligibility from native/source evidence, never report labels.
export async function readRecoveryRetainedCandidate({
  output,
  recording,
  retained,
  maximumDuration,
  signal,
}) {
  if (
    retained.id !== recording.id ||
    !Array.isArray(retained.files) ||
    !Number.isFinite(retained.duration) ||
    retained.duration <= 0 ||
    retained.duration > maximumDuration
  )
    throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
  const suffixes = [
    "native-asr.json",
    "source.json",
    "assessment.json",
    ...(retained.formatting === "passed" ? ["paragraphs.md"] : []),
  ];
  if (retained.files.length !== suffixes.length)
    throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
  const files = new Map();
  for (const suffix of suffixes) {
    const name = `${recording.id}.${suffix}`;
    const proofs = retained.files.filter((file) => file.name === name);
    if (
      proofs.length !== 1 ||
      typeof proofs[0].sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(proofs[0].sha256)
    )
      throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
    const file = await recoveryFile(join(output, name), {
      maximumBytes: 16 * 1024 ** 2,
      includeIdentity: true,
      signal,
    });
    if (file.sha256 !== proofs[0].sha256 || file.bytes !== proofs[0].bytes)
      throw recoveryFailure("RECOVERY_CANDIDATE_EDITED");
    files.set(suffix, file);
  }
  const { candidate, markdown } = assessRecoveryTranscript({
    native: JSON.parse(files.get("native-asr.json").content.toString("utf8")),
    source: JSON.parse(files.get("source.json").content.toString("utf8")),
    duration: retained.duration,
    id: recording.id,
  });
  const assessment = { ...retained };
  delete assessment.files;
  if (
    JSON.stringify(candidate) !== JSON.stringify(assessment) ||
    JSON.stringify(candidate) !==
      JSON.stringify(JSON.parse(files.get("assessment.json").content.toString("utf8"))) ||
    (markdown !== null && files.get("paragraphs.md")?.content.toString("utf8") !== markdown)
  )
    throw recoveryFailure("RECOVERY_CANDIDATE_REVIEW");
  return { files, candidate, markdown };
}
