import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withEvaluationRead } from "./evaluation-read.mjs";
import { recoveryFailure } from "./recovery-files.mjs";

export const INCOMPLETE_RECOVERY_AUTHORITY = "state-owned-unformatted";

export function recoveryAuthorityKind(entry) {
  if (entry.authority === undefined) return "metadata-owned-original";
  if (entry.authority?.kind !== INCOMPLETE_RECOVERY_AUTHORITY)
    throw recoveryFailure("RECOVERY_AUTHORITY_INVALID");
  return INCOMPLETE_RECOVERY_AUTHORITY;
}

export function assertIncompleteRecoveryAuthority({
  entry,
  manifestPath,
  course,
  job,
  checkpoint,
  state,
  queue,
  source,
}) {
  const authority = entry.authority;
  for (const [name, file] of [
    ["state", state],
    ["queue", queue],
  ]) {
    const pin = authority[name];
    if (
      !pin ||
      resolve(dirname(manifestPath), pin.path ?? "") !== file.path ||
      pin.sha256 !== file.sha256
    )
      throw recoveryFailure("RECOVERY_INPUT_CHANGED");
  }
  if (
    !["active", "pilot"].includes(course.mediaMode) ||
    !["content-tree", "media-gallery"].includes(job.storageSurface) ||
    !entry.recordingId.startsWith(`${job.storageSurface}:${course.courseId}:`) ||
    job.stage === "withdrawn" ||
    job.complete === true ||
    checkpoint.complete === true ||
    job.stage === "complete" ||
    checkpoint.stage === "complete" ||
    checkpoint.stage === "withdrawn" ||
    checkpoint.withdrawn === true ||
    checkpoint.safetyFailure !== undefined ||
    job.sourceSha256 !== source.sha256 ||
    job.artifacts?.rawTranscript !== source.path ||
    checkpoint.artifacts?.rawTranscript !== source.path ||
    job.transcript?.complete === true ||
    checkpoint.transcript?.complete === true ||
    [
      job.formattedSha256,
      checkpoint.formattedSha256,
      job.artifacts?.formattedTranscript,
      checkpoint.artifacts?.formattedTranscript,
    ].some((value) => value !== undefined && value !== null)
  )
    throw recoveryFailure("RECOVERY_SOURCE_UNOWNED");
}

export async function pinRecoveryAbsence(path, { declared, manifestPath, signal } = {}) {
  if (
    declared?.absent !== true ||
    declared.sha256 !== undefined ||
    declared.bytes !== undefined ||
    typeof declared.path !== "string" ||
    resolve(dirname(manifestPath), declared.path) !== path
  )
    throw recoveryFailure("RECOVERY_ABSENCE_INVALID");
  return readRecoveryAbsence(path, signal);
}

async function readRecoveryAbsence(path, signal) {
  return withEvaluationRead(
    async (readSignal) => {
      readSignal.throwIfAborted();
      const parentPath = dirname(path);
      if ((await realpath(parentPath)) !== parentPath)
        throw recoveryFailure("RECOVERY_ABSENCE_INVALID");
      const before = await lstat(parentPath);
      if (!before.isDirectory() || before.isSymbolicLink())
        throw recoveryFailure("RECOVERY_ABSENCE_INVALID");
      try {
        await lstat(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const after = await lstat(parentPath);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          (await realpath(parentPath)) !== parentPath
        )
          throw recoveryFailure("RECOVERY_INPUT_CHANGED");
        return {
          path,
          absent: true,
          parent: { path: parentPath, dev: before.dev, ino: before.ino },
        };
      }
      throw recoveryFailure("RECOVERY_ABSENCE_OCCUPIED");
    },
    { signal },
  );
}

export async function assertRecoveryAbsences(absences = [], signal) {
  for (const input of absences) {
    const current = await readRecoveryAbsence(input.path, signal);
    if (
      current.parent.path !== input.parent.path ||
      current.parent.dev !== input.parent.dev ||
      current.parent.ino !== input.parent.ino
    )
      throw recoveryFailure("RECOVERY_INPUT_CHANGED");
  }
}
