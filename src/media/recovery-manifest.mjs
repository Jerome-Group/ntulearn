import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { readMediaQueue, mediaQueuePath } from "./queue.mjs";
import { mediaRecordingRoot } from "./storage.mjs";
import { recordingDisposition } from "./disposition.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";
import { inspectHistoricalSource } from "./historical-format.mjs";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";
import {
  recoveryAuthorityKind,
  INCOMPLETE_RECOVERY_AUTHORITY,
  assertIncompleteRecoveryAuthority,
  pinRecoveryAbsence,
  assertRecoveryAbsences,
} from "./recovery-authority.mjs";
import { RECOVERY_POLICIES } from "./recovery-policy.mjs";
import { courseUrl } from "../ntulearn/urls.mjs";
import { mediaRecordingStatus, mediaRecordingStatusPath } from "./status.mjs";
import { publicMediaError } from "./errors.mjs";

export const RECOVERY_MAXIMUM_BUDGETS = Object.freeze({
  maxRecordingSeconds: 8 * 3600,
  maxInputBytes: 32 * 1024 ** 3,
  maxOutputBytes: 32 * 1024 ** 3,
  jobTimeoutMs: 24 * 3600000,
  processTimeoutMs: 8 * 3600000,
});
const SHA = /^[0-9a-f]{64}$/;
const inside = (root, path) => path.startsWith(root + sep);
const fingerprint = ({ path, sha256, bytes }) => ({ path, sha256, bytes });

export async function readRecoveryManifest({ manifestPath, config, signal }) {
  const path = resolve(manifestPath);
  const manifestFile = await recoveryFile(path, { maximumBytes: 256 * 1024, signal });
  const manifest = JSON.parse(manifestFile.content.toString("utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    !RECOVERY_POLICIES.includes(manifest.policy) ||
    !Array.isArray(manifest.recordings) ||
    !manifest.recordings.length ||
    manifest.recordings.length > 64
  )
    throw recoveryFailure("RECOVERY_MANIFEST_INVALID");
  for (const [key, maximum] of Object.entries(RECOVERY_MAXIMUM_BUDGETS))
    if (
      !Number.isSafeInteger(manifest.budgets?.[key]) ||
      manifest.budgets[key] <= 0 ||
      manifest.budgets[key] > maximum
    )
      throw recoveryFailure("RECOVERY_BUDGET_INVALID");
  if (manifest.budgets.processTimeoutMs > manifest.budgets.jobTimeoutMs)
    throw recoveryFailure("RECOVERY_BUDGET_INVALID");
  const store = await realpath(config.media.mediaRoot);
  const courses = new Map(),
    jobs = [],
    queues = new Map(),
    protectedAbsences = [],
    protectedInputs = [fingerprint(manifestFile)];
  for (const course of config.courses) {
    const destination = await realpath(course.destination);
    if (courses.has(course.key)) throw recoveryFailure();
    courses.set(course.key, { ...course, destination });
    const queuePath = mediaQueuePath(config.statePath, course.key);
    const queueFile = await recoveryFile(queuePath, { signal });
    protectedInputs.push(fingerprint(queueFile));
    queues.set(course.key, queueFile);
    const loaded = await readMediaQueue({
      statePath: config.statePath,
      courseKey: course.key,
      course,
      read: async () => queueFile.content,
    });
    for (const job of loaded.record?.queue ?? []) jobs.push({ job, courseKey: course.key });
  }
  const recordings = [],
    identities = new Set();
  let inputBytes = 0;
  for (const [index, entry] of manifest.recordings.entries()) {
    safeNativeTranscriptBody(entry);
    const course = courses.get(entry.courseKey);
    const authority = recoveryAuthorityKind(entry);
    if (
      !course ||
      typeof entry.recordingId !== "string" ||
      identities.has(entry.recordingId) ||
      !["content-tree", "media-gallery"].some((surface) =>
        entry.recordingId.startsWith(`${surface}:${course.courseId}:`),
      )
    )
      throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
    identities.add(entry.recordingId);
    const claims = jobs.filter(({ job }) => job.recordingId === entry.recordingId);
    if (claims.length !== 1 || claims[0].courseKey !== course.key)
      throw recoveryFailure("RECOVERY_ASSOCIATION_AMBIGUOUS");
    const job = claims[0].job;
    if (
      recordingDisposition(job) !== "recording" ||
      job.withdrawn ||
      job.courseId !== course.courseId ||
      job.safetyFailure !== undefined
    )
      throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
    const recordingRoot = mediaRecordingRoot(store, entry.recordingId);
    const sourcePath = join(recordingRoot, "transcript.raw.json");
    if (
      !entry.source ||
      resolve(dirname(path), entry.source.path ?? "") !== sourcePath ||
      !SHA.test(entry.source.sha256 ?? "")
    )
      throw recoveryFailure("RECOVERY_SOURCE_INVALID");
    const source = await recoveryFile(sourcePath, { signal });
    if (source.sha256 !== entry.source.sha256) throw recoveryFailure("RECOVERY_INPUT_CHANGED");
    const inspected = inspectHistoricalSource(source.content);
    if (!inspected.valid || !inspected.eligible) throw recoveryFailure("RECOVERY_SOURCE_INVALID");
    const state = await recoveryFile(join(recordingRoot, "transcript.state.json"), { signal });
    const checkpoint = JSON.parse(state.content.toString("utf8"));
    safeNativeTranscriptBody(checkpoint);
    if (checkpoint.recordingId !== entry.recordingId || checkpoint.sourceSha256 !== source.sha256)
      throw recoveryFailure("RECOVERY_SOURCE_UNOWNED");
    let metadata, proof;
    if (authority === INCOMPLETE_RECOVERY_AUTHORITY) {
      if (
        typeof job.placement?.destination !== "string" ||
        (await realpath(job.placement.destination)) !== course.destination
      )
        throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
      assertIncompleteRecoveryAuthority({
        entry,
        manifestPath: path,
        course,
        job,
        checkpoint,
        state,
        queue: queues.get(course.key),
        source,
      });
      metadata = await pinRecoveryAbsence(join(recordingRoot, "transcript.metadata.json"), {
        declared: entry.authority.metadata,
        manifestPath: path,
        signal,
      });
      proof = checkpoint;
    } else {
      metadata = await recoveryFile(join(recordingRoot, "transcript.metadata.json"), { signal });
      proof = JSON.parse(metadata.content.toString("utf8"));
      safeNativeTranscriptBody(proof);
      if (proof.recordingId !== entry.recordingId || proof.sourceSha256 !== source.sha256)
        throw recoveryFailure("RECOVERY_SOURCE_UNOWNED");
    }
    if (!entry.media || typeof entry.media.path !== "string" || !SHA.test(entry.media.sha256 ?? ""))
      throw recoveryFailure("RECOVERY_MEDIA_INVALID");
    const mediaPath = resolve(dirname(path), entry.media.path);
    const declared = await ownedMediaPaths(proof.media);
    const checkpointPaths = await ownedMediaPaths(checkpoint.media);
    if (
      authority === INCOMPLETE_RECOVERY_AUTHORITY &&
      !(await ownedMediaPaths(job.media)).includes(mediaPath)
    )
      throw recoveryFailure("RECOVERY_MEDIA_UNOWNED");
    if (typeof checkpoint.artifacts?.media === "string")
      checkpointPaths.push(await realpath(checkpoint.artifacts.media));
    if (!declared.includes(mediaPath) || !checkpointPaths.includes(mediaPath))
      throw recoveryFailure("RECOVERY_MEDIA_UNOWNED");
    const permitted =
      job.storageSurface === "media-gallery"
        ? inside(join(recordingRoot, "media"), mediaPath)
        : [job.placement?.videoPath, job.placement?.audioPath]
            .filter(Boolean)
            .some((value) => resolve(course.destination, value) === mediaPath);
    if (
      !permitted ||
      (job.storageSurface !== "media-gallery" && !inside(course.destination, mediaPath))
    )
      throw recoveryFailure("RECOVERY_MEDIA_UNOWNED");
    const media = await recoveryFile(mediaPath, {
      maximumBytes: manifest.budgets.maxInputBytes,
      signal,
      retain: false,
    });
    if (media.sha256 !== entry.media.sha256) throw recoveryFailure("RECOVERY_INPUT_CHANGED");
    const originalPath = resolve(course.destination, job.placement?.formattedTranscriptPath ?? "");
    if (
      !inside(course.destination, originalPath) ||
      (await realpath(job.placement.destination)) !== course.destination
    )
      throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
    const competingOriginal = jobs.some(
      ({ job: other, courseKey }) =>
        other.recordingId !== entry.recordingId &&
        other.placement?.formattedTranscriptPath &&
        courses.get(courseKey) &&
        resolve(courses.get(courseKey).destination, other.placement.formattedTranscriptPath) ===
          originalPath,
    );
    if (competingOriginal) throw recoveryFailure("RECOVERY_ASSOCIATION_AMBIGUOUS");
    let original;
    if (authority === INCOMPLETE_RECOVERY_AUTHORITY) {
      original = await pinRecoveryAbsence(originalPath, {
        declared: entry.authority.original,
        manifestPath: path,
        signal,
      });
      protectedAbsences.push(metadata, original);
    } else {
      original = await recoveryFile(originalPath, { signal });
      if (
        proof.formattedSha256 !== original.sha256 ||
        checkpoint.formattedSha256 !== original.sha256
      )
        throw recoveryFailure("RECOVERY_ORIGINAL_EDITED");
    }
    inputBytes += source.bytes + media.bytes + (original.bytes ?? 0);
    if (inputBytes > manifest.budgets.maxInputBytes) throw recoveryFailure("RECOVERY_INPUT_BUDGET");
    protectedInputs.push(
      ...[source, metadata, state, original, media].filter((file) => !file.absent).map(fingerprint),
    );
    const display = mediaRecordingStatus({ appearance: job, job });
    const statusPath = mediaRecordingStatusPath({
      ...job,
      placement: { ...job.placement, destination: course.destination },
    });
    if (statusPath && !inside(course.destination, statusPath))
      throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
    recordings.push({
      id: `recording-${index + 1}`,
      courseKey: course.key,
      recordingId: entry.recordingId,
      coursePath: course.destination,
      source: fingerprint(source),
      media: fingerprint(media),
      original: original.absent ? original : fingerprint(original),
      metadata: metadata.absent ? metadata : fingerprint(metadata),
      ...(authority === INCOMPLETE_RECOVERY_AUTHORITY ? { authority } : {}),
      state: fingerprint(state),
      sourceFlags: inspected.flags,
      display: {
        courseKey: publicMediaError(course.key),
        title: publicMediaError(display.title).slice(0, 500),
        courseUrl: courseUrl(encodeURIComponent(course.courseId)),
        sourceReference: publicMediaError(display.sourceReference ?? "unavailable").slice(0, 500),
        statusPath,
      },
    });
  }
  const budgets = Object.fromEntries(
    Object.keys(RECOVERY_MAXIMUM_BUDGETS).map((key) => [key, manifest.budgets[key]]),
  );
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        policy: manifest.policy,
        budgets,
        recordings,
        protectedInputs,
        ...(protectedAbsences.length ? { protectedAbsences } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    schemaVersion: 1,
    id,
    policy: manifest.policy,
    budgets,
    recordings,
    protectedInputs,
    ...(protectedAbsences.length ? { protectedAbsences } : {}),
  };
}

async function ownedMediaPaths(media) {
  const values = [
    media?.video?.available === true && media.video.audio !== false ? media.video.path : null,
    media?.audio?.available === true ? media.audio.path : null,
  ];
  return Promise.all(
    values.filter((value) => typeof value === "string").map((value) => realpath(value)),
  );
}

export async function assertRecoveryInputs(manifest, signal, { includeMedia = true } = {}) {
  await assertRecoveryAbsences(manifest.protectedAbsences, signal);
  const mediaPaths = new Set(manifest.recordings?.map((recording) => recording.media.path) ?? []);
  for (const input of manifest.protectedInputs) {
    if (!includeMedia && mediaPaths.has(input.path)) continue;
    const current = await recoveryFile(input.path, {
      maximumBytes: Math.max(4 * 1024 ** 2, input.bytes),
      signal,
      retain: false,
    });
    if (current.sha256 !== input.sha256 || current.bytes !== input.bytes)
      throw recoveryFailure("RECOVERY_INPUT_CHANGED");
  }
  await assertRecoveryAbsences(manifest.protectedAbsences, signal);
}
