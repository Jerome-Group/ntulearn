import { join, resolve, sep } from "node:path";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";
import { readRecoveryRetainedCandidate } from "./recovery-retained-candidate.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const invalid = () => recoveryFailure("RECOVERY_RESUME_INVALID");

// Reuse authority comes exclusively from a failed report's hashed contiguous prefix.
export async function qualifyRecoveryResume({
  directory,
  reportSha256,
  boundary,
  manifest,
  runtimePins,
  signal,
}) {
  if (typeof directory !== "string" || typeof reportSha256 !== "string") throw invalid();
  const output = resolve(directory);
  if (!output.startsWith(boundary + sep)) throw invalid();
  const plan = await recoveryFile(join(output, "plan.json"), { signal, includeIdentity: true });
  const reportFile = await recoveryFile(join(output, "recovery.json"), {
    signal,
    includeIdentity: true,
  });
  if (!/^[0-9a-f]{64}$/.test(reportSha256 ?? "") || reportFile.sha256 !== reportSha256)
    throw invalid();
  const report = JSON.parse(reportFile.content.toString("utf8"));
  safeNativeTranscriptBody(report);
  if (
    !same(JSON.parse(plan.content.toString("utf8")), manifest) ||
    !same(report.manifest, manifest) ||
    report.schemaVersion !== 1 ||
    typeof report.runId !== "string" ||
    !/^[0-9a-f]{32}$/.test(report.runId) ||
    typeof report.failureCode !== "string" ||
    !/^(?:RECOVERY|MEDIA)_[A-Z_]+$/.test(report.failureCode) ||
    !same(report.runtimePins, runtimePins) ||
    !Array.isArray(report.candidates) ||
    report.candidates.length > manifest.recordings.length ||
    !Array.isArray(report.stages)
  )
    throw invalid();
  const pins = [plan, reportFile],
    candidates = [];
  for (const [index, retained] of report.candidates.entries()) {
    const recording = manifest.recordings[index];
    const { files } = await readRecoveryRetainedCandidate({
      output,
      recording,
      retained,
      maximumDuration: manifest.budgets.maxRecordingSeconds,
      signal,
    });
    for (const file of files.values()) pins.push({ ...file, content: undefined });
    candidates.push(retained);
  }
  const completedStages = report.stages.slice(0, candidates.length * 3);
  const labels = ["Recovery duration probe", "ASR audio extraction", "Whisper transcription"];
  if (
    completedStages.length !== candidates.length * 3 ||
    completedStages.some(
      (stage, index) =>
        stage.stage !== labels[index % 3] ||
        stage.status !== "passed" ||
        !Number.isFinite(stage.wallMs) ||
        stage.wallMs < 0,
    )
  )
    throw invalid();
  const qualified = {
    candidates,
    pins,
    stages: completedStages.map((stage) => ({ ...stage, reused: true })),
    ancestry: {
      reportSha256: reportFile.sha256,
      runId: report.runId,
      failureCode: report.failureCode,
      reusedCandidates: candidates.length,
      ...(report.resumeFrom ? { previous: report.resumeFrom } : {}),
    },
  };
  await assertRecoveryResumePins(qualified, signal);
  return qualified;
}

export async function assertRecoveryResumePins({ pins }, signal) {
  for (const pin of pins) {
    const file = await recoveryFile(pin.path, {
      maximumBytes: 16 * 1024 ** 2,
      retain: false,
      signal,
      includeIdentity: true,
    });
    if (
      file.sha256 !== pin.sha256 ||
      file.bytes !== pin.bytes ||
      !same(file.identity, pin.identity)
    )
      throw recoveryFailure("RECOVERY_RESUME_CHANGED");
  }
}

export async function copyRecoveryResumePrefix(qualified, put, signal) {
  for (const candidate of qualified.candidates) {
    await assertRecoveryResumePins(qualified, signal);
    for (const proof of candidate.files) {
      const pin = qualified.pins.find((file) => file.path.endsWith(sep + proof.name));
      const file = await recoveryFile(pin.path, {
        maximumBytes: 16 * 1024 ** 2,
        signal,
        includeIdentity: true,
      });
      if (
        file.sha256 !== proof.sha256 ||
        file.bytes !== proof.bytes ||
        !same(file.identity, pin.identity)
      )
        throw recoveryFailure("RECOVERY_RESUME_CHANGED");
      await put(proof.name, file.content);
    }
  }
  await assertRecoveryResumePins(qualified, signal);
}

export async function assertCopiedRecoveryPrefix(output, qualified, signal) {
  for (const candidate of qualified.candidates)
    for (const proof of candidate.files) {
      const file = await recoveryFile(join(output, proof.name), {
        maximumBytes: 16 * 1024 ** 2,
        retain: false,
        signal,
      });
      if (file.sha256 !== proof.sha256 || file.bytes !== proof.bytes)
        throw recoveryFailure("RECOVERY_RESUME_CHANGED");
    }
}
