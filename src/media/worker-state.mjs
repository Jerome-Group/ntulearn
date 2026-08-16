import { publicMediaError } from "./errors.mjs";
import { isMediaJobComplete } from "./completeness.mjs";

export function resultUpdate(result, finishedAt) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return failureUpdate(new Error("Media job returned no result."), finishedAt);
  }
  const complete = isMediaJobComplete(result);
  const stage = result.stage === "complete" && !complete ? "failed" : result.stage;
  return {
    complete,
    stage: stage ?? (complete ? "complete" : "failed"),
    verdict: complete ? (result.verdict ?? "green") : "red",
    retryable: result.retryable ?? !complete,
    limitations: safeLimitations(result.limitations, result.limitation),
    ...(result.provider ? { providerName: result.provider } : {}),
    ...(result.providerName ? { providerName: result.providerName } : {}),
    ...(result.transcript ? { transcript: result.transcript } : {}),
    ...(result.media ? { media: result.media } : {}),
    ...(result.artifacts ? { artifacts: artifactPaths(result.artifacts) } : {}),
    ...(result.formatterVersion ? { formatterVersion: result.formatterVersion } : {}),
    ...(result.sourceSha256 ? { sourceSha256: result.sourceSha256 } : {}),
    ...(result.formattedSha256 ? { formattedSha256: result.formattedSha256 } : {}),
    ...(result.duration ? { duration: result.duration } : {}),
    ...(result.speechDuration ? { speechDuration: result.speechDuration } : {}),
    finishedAt: finishedAt.toISOString(),
    lastError: null,
    checkpoint: null,
  };
}

export function failureUpdate(error, finishedAt) {
  const message = publicMediaError(error);
  return {
    complete: false,
    stage: "failed",
    verdict: "red",
    retryable: true,
    limitations: [message],
    limitation: message,
    finishedAt: finishedAt.toISOString(),
    lastError: message,
    checkpoint: null,
  };
}

export function checkpointUpdate({ result, failure, finishedAt }) {
  const base = failure
    ? failureUpdate(failure, finishedAt)
    : resultUpdate(result ?? { complete: false }, finishedAt);
  return {
    ...base,
    complete: false,
    stage: "checkpointed",
    verdict: "yellow",
    retryable: true,
    checkpoint: {
      at: finishedAt.toISOString(),
      reason: "overnight window ended",
    },
  };
}

export function finishedJob(job) {
  return job?.withdrawn === true || job?.stage === "withdrawn" || isMediaJobComplete(job);
}

export function artifactPaths(artifacts) {
  return Object.fromEntries(
    Object.entries(artifacts)
      .filter(([, artifact]) => typeof artifact?.path === "string")
      .map(([kind, artifact]) => [kind, artifact.path]),
  );
}

export function safeLimitations(limitations, limitation) {
  return [
    ...new Set([...(Array.isArray(limitations) ? limitations : []), limitation].filter(Boolean)),
  ].map((value) => publicMediaError(value));
}
