import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { assertMediaArtifactPath, mediaRecordingRoot } from "./storage.mjs";
import { publicMediaError, markGlobalMediaSafety, unconfirmedMediaCleanupCode } from "./errors.mjs";
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
  const safetyFailure = unconfirmedMediaCleanupCode(error);
  return {
    complete: false,
    stage: "failed",
    verdict: "red",
    retryable: !safetyFailure,
    ...(safetyFailure ? { safetyFailure } : {}),
    limitations: [message],
    limitation: message,
    finishedAt: finishedAt.toISOString(),
    lastError: message,
    checkpoint: null,
  };
}

export function checkpointUpdate({
  result,
  failure,
  finishedAt,
  reason = "overnight window ended",
}) {
  const base =
    failure !== undefined
      ? failureUpdate(failure, finishedAt)
      : resultUpdate(result ?? { complete: false }, finishedAt);
  if (base.safetyFailure) return base;
  return {
    ...base,
    complete: false,
    stage: "checkpointed",
    verdict: "yellow",
    retryable: true,
    checkpoint: {
      at: finishedAt.toISOString(),
      reason,
    },
  };
}

export function finishedJob(job) {
  return (
    job?.withdrawn === true ||
    job?.stage === "withdrawn" ||
    (job?.stage === "failed" && job?.retryable === false) ||
    isMediaJobComplete(job)
  );
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

export async function mediaArtifactEvidenceUpdate(job, { mediaRoot, course } = {}) {
  if (job.safetyFailure !== undefined || !isMediaJobComplete(job)) return null;
  const artifacts = job.artifacts ?? {};
  const sourceRoot =
    typeof mediaRoot === "string" ? mediaRecordingRoot(resolve(mediaRoot), job.recordingId) : null;
  const destination = course?.destination;
  const raw =
    sourceRoot && artifacts.rawTranscript === resolve(sourceRoot, "transcript.raw.json")
      ? await artifactBytes(artifacts.rawTranscript, mediaRoot)
      : null;
  const formatted = destination
    ? await artifactBytes(artifacts.formattedTranscript, destination)
    : null;
  let sourceSha256 = job.sourceSha256;
  let formattedSha256 = job.formattedSha256;
  if (raw && formatted && (!sourceSha256 || !formattedSha256)) {
    for (const filename of ["transcript.metadata.json", "transcript.state.json"]) {
      const body = await artifactBytes(resolve(sourceRoot, filename), mediaRoot);
      let proof;
      try {
        proof = body ? JSON.parse(body.toString("utf8")) : null;
      } catch {
        proof = null;
      }
      if (
        proof?.recordingId === job.recordingId &&
        /^[0-9a-f]{64}$/.test(proof.sourceSha256) &&
        /^[0-9a-f]{64}$/.test(proof.formattedSha256)
      ) {
        sourceSha256 ??= proof.sourceSha256;
        formattedSha256 ??= proof.formattedSha256;
        break;
      }
    }
  }
  const sourceChanged = raw && sourceSha256 && digest(raw) !== sourceSha256;
  const formattedChanged = formatted && formattedSha256 && digest(formatted) !== formattedSha256;
  const proofMissing = raw && formatted && (!sourceSha256 || !formattedSha256);
  if (raw && formatted && !sourceChanged && !formattedChanged && !proofMissing) {
    return job.sourceSha256 && job.formattedSha256 ? null : { sourceSha256, formattedSha256 };
  }
  const requiresReview = Boolean(
    sourceChanged || formattedChanged || proofMissing || (!raw && formatted),
  );
  const limitation = requiresReview
    ? "Preserved transcript evidence changed, its source is missing, or ownership digests are unavailable. Existing artifacts retained; explicit regeneration or Owner review is required."
    : "Recorded transcript artifacts are missing. Safe retry will recreate missing artifacts without replacing existing files.";
  return {
    complete: false,
    stage: requiresReview ? "failed" : "queued",
    verdict: requiresReview ? "red" : "yellow",
    retryable: !requiresReview,
    transcript: { ...job.transcript, complete: false },
    limitations: [...new Set([...(job.limitations ?? []), limitation])],
  };
}

async function artifactBytes(path, root) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\0\r\n]|:\/\//.test(path)) return null;
  const target = resolve(path);
  const boundary = resolve(root);
  if (!target.startsWith(`${boundary}${sep}`)) return null;
  await assertMediaArtifactPath(target, boundary);
  return readFile(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    const failure = new Error(
      `Transcript evidence cannot be read (${error.code ?? "filesystem error"}). Check artifact permissions and the mounted course/Media store before retrying.`,
      { cause: error },
    );
    failure.code = error.code;
    throw markGlobalMediaSafety(failure);
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
