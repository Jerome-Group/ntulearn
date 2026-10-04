import { GLOBAL_MEDIA_ERROR_CODES } from "./errors.mjs";

export const WORKER_STOP_CODES = Object.freeze([
  ...GLOBAL_MEDIA_ERROR_CODES,
  "MEDIA_CAPACITY_TIMEOUT",
  "MEDIA_CAPACITY_DESTINATION_UNVERIFIED",
  "MEDIA_SAFETY_BARRIER",
  "MEDIA_SAFETY_BARRIER_WRITE",
  "MEDIA_QUEUE_DESTINATION_UNVERIFIED",
  "MEDIA_QUEUE_LOCK_HELD",
  "ENOENT",
  "EEXIST",
  "EINVAL",
  "EMFILE",
  "ENFILE",
  "EISDIR",
  "ELOOP",
  "ENOTDIR",
  "UNKNOWN",
]);
export const WORKER_STOP_STAGES = Object.freeze([
  "admission",
  "preflight",
  "queue-read",
  "artifact-evidence",
  "queue-active",
  "job",
  "capacity",
  "queue-interruption",
  "queue-checkpoint",
  "queue-failure",
  "queue-result",
  "course-status",
  "recording-status",
  "runner-settlement",
  "unknown",
]);

export function workerStopFailure(error, stage) {
  let code = "UNKNOWN";
  const seen = new Set();
  try {
    for (let depth = 0; error && depth < 8 && !seen.has(error); depth++) {
      seen.add(error);
      if (WORKER_STOP_CODES.includes(error.code)) {
        code = error.code;
        break;
      }
      error = error.cause;
    }
  } catch {
    code = "UNKNOWN";
  }
  return { code, stage: WORKER_STOP_STAGES.includes(stage) ? stage : "unknown" };
}

export function addWorkerStopFailure(failures, error, stage) {
  const failure = workerStopFailure(error, stage);
  if (!failures.some((item) => item.code === failure.code && item.stage === failure.stage))
    failures.push(failure);
}

export function workerStopEvidence(failures) {
  const checked = [];
  for (const failure of (Array.isArray(failures) ? failures : []).slice(0, 16))
    addWorkerStopFailure(checked, failure, failure?.stage);
  if (!checked.length || failures?.length > 16) addWorkerStopFailure(checked, null, "unknown");
  return checked;
}
