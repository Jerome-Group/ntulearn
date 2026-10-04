import { queueCourseBoundary } from "./queue-course.mjs";
import { recordingDisposition } from "./disposition.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { publicMediaError, markGlobalMediaSafety } from "./errors.mjs";
import { isMediaJobComplete } from "./completeness.mjs";
import { positiveDuration } from "./duration.mjs";
import { validateSourceReviewFlags } from "./source-paragraphs.mjs";
import { writeMediaCourseStatus, writeMediaRecordingStatus } from "./status.mjs";

const QUEUE_VERSION = 1;
const JOB_STATE_FIELDS = Object.freeze([
  "complete",
  "stage",
  "verdict",
  "retryable",
  "safetyFailure",
  "withdrawn",
  "artifacts",
  "limitations",
  "limitation",
  "transcript",
  "media",
  "providerName",
  "formatterVersion",
  "sourceSha256",
  "formattedSha256",
  "duration",
  "speechDuration",
  "checkpoint",
  "attempts",
  "startedAt",
  "finishedAt",
  "lastError",
]);
export const EPHEMERAL_MEDIA_JOB_FIELDS = Object.freeze([
  "resolved",
  "resolvedUrl",
  "sourceUrl",
  "session",
  "token",
  "signature",
  "cookies",
  "requestHeaders",
]);
const EPHEMERAL_JOB_FIELDS = new Set(EPHEMERAL_MEDIA_JOB_FIELDS);

export async function writeMediaQueue({
  statePath,
  course,
  discovery,
  withdrawal = null,
  now = () => new Date(),
  write = writeAtomically,
  read = readFile,
}) {
  const path = mediaQueuePath(statePath, course.key);
  const boundary = queueCourseBoundary({ course });
  const existing = await readMediaQueue({
    statePath,
    courseKey: course.key,
    course,
    read,
    boundary,
  });
  const discoveredQueue =
    discovery.complete === true && Array.isArray(discovery.queue) ? discovery.queue : [];
  await boundary.assert(discoveredQueue, course.courseId);
  const reconciledQueue =
    discovery.complete === true
      ? mergeQueue(existing.record?.queue, discoveredQueue, boundary)
      : (existing.record?.queue ?? []);
  const transition =
    discovery.complete === true && withdrawal
      ? withdrawQueuedRecording({ queue: reconciledQueue, ...withdrawal })
      : { status: "written", queue: reconciledQueue };
  const queue = transition.queue;
  await write(
    path,
    queueJson({
      version: QUEUE_VERSION,
      courseKey: course.key,
      courseId: course.courseId,
      complete: discovery.complete === true,
      verdict: discovery.complete === true ? (discovery.verdict ?? "red") : "red",
      displayedCount: discovery.displayedCount ?? null,
      discoveredCount: discovery.discoveredCount ?? 0,
      ...(discovery.contentCount === undefined ? {} : { contentCount: discovery.contentCount }),
      ...(discovery.galleryCount === undefined ? {} : { galleryCount: discovery.galleryCount }),
      queue,
      limitations: discovery.limitations ?? [],
      updatedAt: now().toISOString(),
    }),
  );
  const status = await persistQueueStatuses({
    course,
    discovery,
    queue,
    boundary,
    now,
    write,
  });
  return { path, status: transition.status, statusPath: status?.path };
}

export function mediaQueuePath(statePath, courseKey) {
  return join(dirname(statePath), "media-queue", `${safeCourseKey(courseKey)}.json`);
}

export async function readMediaQueue({
  statePath,
  courseKey,
  course = null,
  read = readFile,
  boundary = queueCourseBoundary({ course }),
}) {
  const path = mediaQueuePath(statePath, courseKey);
  let content = await read(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const legacyPath = join(
    dirname(statePath),
    "media-queue",
    `${
      String(courseKey)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "_") || "course"
    }.json`,
  );
  let legacy = false;
  if (!content && legacyPath !== path) {
    legacy = true;
    content = await read(legacyPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  const record = content ? JSON.parse(content) : null;
  if (
    legacy &&
    record &&
    (String(record.courseKey).toLowerCase() !== String(courseKey).toLowerCase() ||
      (course && record.courseId !== course.courseId))
  )
    return { path, record: null };
  if (
    record &&
    (String(record.courseKey).toLowerCase() !== String(courseKey).toLowerCase() ||
      (course && record.courseId !== course.courseId))
  ) {
    throw new Error(
      "Media queue belongs to another course. Run media discovery for the configured course; existing artifacts are retained.",
    );
  }
  await boundary.assert(record?.queue, record?.courseId);
  return { path, record };
}

export async function updateMediaQueueJob({
  statePath,
  courseKey,
  recordingId,
  update,
  course = null,
  now = () => new Date(),
  write = writeAtomically,
  read = readFile,
}) {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Media queue job updates need an object.");
  }

  const boundary = queueCourseBoundary({ course });
  const loaded = await readMediaQueue({ statePath, courseKey, course, read, boundary });
  if (!loaded.record || !Array.isArray(loaded.record.queue)) {
    throw new Error(
      `No durable media queue exists for ${courseKey}. Run: npm run media:discover -- ${courseKey}`,
    );
  }
  const index = loaded.record.queue.findIndex((job) => job?.recordingId === recordingId);
  if (index === -1) {
    throw new Error(`Media queue has no recording ${recordingId} for ${courseKey}.`);
  }

  const safeUpdate = sanitizeJobState(update);
  const queue = loaded.record.queue.map((job, jobIndex) => {
    const durableJob = stripEphemeralFields(job);
    if (jobIndex !== index) return durableJob;
    if (
      durableJob.transcript?.reviewRequired === true &&
      (safeUpdate.complete === true ||
        safeUpdate.retryable === true ||
        (safeUpdate.stage !== undefined && !["failed", "withdrawn"].includes(safeUpdate.stage)) ||
        (safeUpdate.transcript &&
          (safeUpdate.transcript.reviewRequired !== true ||
            !durableJob.transcript.flags.every((flag) =>
              safeUpdate.transcript.flags?.includes(flag),
            ))))
    )
      throw new Error(
        "Retained transcript source review cannot be cleared or resumed by a queue-only change. Inspect source evidence and use explicit source-preserving recovery.",
      );
    if (
      durableJob.safetyFailure !== undefined &&
      (safeUpdate.complete === true ||
        safeUpdate.retryable === true ||
        (safeUpdate.stage !== undefined && safeUpdate.stage !== "failed") ||
        (safeUpdate.safetyFailure !== undefined &&
          safeUpdate.safetyFailure !== durableJob.safetyFailure))
    ) {
      throw markGlobalMediaSafety(
        new Error(
          "Retained media cleanup safety evidence cannot be resumed automatically. The Owner must verify cessation and inspect the barrier before explicit recovery.",
        ),
      );
    }
    const nextJob = { ...durableJob, ...safeUpdate };
    if (Array.isArray(durableJob.limitations) && Array.isArray(safeUpdate.limitations)) {
      nextJob.limitations = [...new Set([...durableJob.limitations, ...safeUpdate.limitations])];
    }
    return nextJob;
  });
  const record = { ...loaded.record, queue, updatedAt: now().toISOString() };
  await write(loaded.path, queueJson(record));
  const status = await persistQueueStatuses({
    course,
    discovery: record,
    queue,
    now,
    write,
    recording: queue[index],
    boundary,
  });
  return { path: loaded.path, record, job: queue[index], statusPath: status?.path };
}

export function withdrawQueuedRecording({ queue, recordingId, confirmed }) {
  if (!Array.isArray(queue)) throw new Error("Media queue withdrawal needs a queue.");
  const index = queue.findIndex((job) => job?.recordingId === recordingId);
  if (index === -1) return { status: "not-found", queue };

  const current = queue[index];
  if (isMediaJobComplete(current)) return { status: "retained", queue };
  if (confirmed !== true) return { status: "confirmation-required", queue };

  const next = queue.map((job, jobIndex) =>
    jobIndex === index
      ? {
          ...job,
          stage: "withdrawn",
          withdrawn: true,
          retryable: false,
        }
      : job,
  );
  return { status: "withdrawn", queue: next };
}

function mergeQueue(previousQueue, discoveredQueue, boundary) {
  const previous = Array.isArray(previousQueue) ? previousQueue : [];
  const previousById = new Map(
    previous.filter((job) => job?.recordingId).map((job) => [job.recordingId, job]),
  );
  const priorCandidates = Map.groupBy(previous, candidateKey);
  const freshCandidates = Map.groupBy(discoveredQueue, candidateKey);
  const retainedIds = new Set();
  const merged = discoveredQueue.map((appearance) => {
    const key = candidateKey(appearance);
    const matches = priorCandidates.get(key) ?? [];
    const old =
      previousById.get(appearance?.recordingId) ??
      (key && matches.length === 1 && freshCandidates.get(key)?.length === 1 ? matches[0] : null);
    if (!old) return stripEphemeralFields(appearance);
    retainedIds.add(old.recordingId);
    const reconciled = {
      ...stripEphemeralFields(appearance),
      ...preservedState(old),
      recordingId: old.recordingId,
      ...(old.placement ? { placement: old.placement } : {}),
      ...(appearance.limitation ? { limitation: appearance.limitation } : {}),
    };
    const disposition = recordingDisposition(appearance);
    if (disposition === "non-recording" && retainedRecordingEvidence(old)) {
      reconciled.disposition = "unresolved";
      reconciled.classificationEvidence = "conflicting-retained-recording";
      reconciled.limitation =
        "Fresh document metadata conflicts with retained recording evidence. Artifacts and history preserved; inspect the appearance before further acquisition.";
    } else if (
      disposition === "recording" &&
      (recordingDisposition(old) !== "recording" || old.provider !== appearance.provider) &&
      !isMediaJobComplete(old) &&
      old.transcript?.reviewRequired !== true &&
      !old.transcript?.flags?.length &&
      !old.withdrawn &&
      old.safetyFailure === undefined
    ) {
      Object.assign(reconciled, {
        complete: false,
        stage: "queued",
        verdict: "yellow",
        retryable: true,
      });
      if (appearance.providerName) reconciled.providerName = appearance.providerName;
    }
    return reconciled;
  });
  return rejectPlacementCollisions(
    [
      ...merged,
      ...previous.filter(
        (job) =>
          job?.recordingId &&
          !retainedIds.has(job.recordingId) &&
          !merged.some((fresh) => fresh.recordingId === job.recordingId),
      ),
    ],
    boundary,
  );
}

function candidateKey(job) {
  if (!job?.itemId || !job.sourceKind) return null;
  let reference = job.candidateReference;
  if (!reference && typeof job.providerReference === "string") {
    const body = job.providerReference
      .replace(
        /^unsupported:(?:ntulearn-file|feedbackfruits|cengage|blackboard|padlet|turnitin):/,
        "",
      )
      .replace(/^(?:unsupported|direct):/, "");
    if (body !== job.providerReference) reference = `candidate:${body}`;
  }
  return reference ? `${job.itemId}:${job.sourceKind}:${reference}` : null;
}

function retainedRecordingEvidence(job) {
  return (
    job.transcript?.complete === true ||
    job.media?.video?.available === true ||
    job.media?.audio?.available === true ||
    ["rawTranscript", "formattedTranscript", "providerTranscript", "media"].some(
      (kind) => typeof job.artifacts?.[kind] === "string",
    )
  );
}

function preservedState(job) {
  const state = Object.fromEntries(
    JOB_STATE_FIELDS.filter((field) => Object.hasOwn(job, field)).map((field) => [
      field,
      job[field],
    ]),
  );
  return sanitizeJobState(state, { dropInvalidDurations: true });
}

function queueJson(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function stripEphemeralFields(job) {
  return Object.fromEntries(
    Object.entries(job).filter(([field]) => !EPHEMERAL_JOB_FIELDS.has(field)),
  );
}

function sanitizeJobState(update, { dropInvalidDurations = false } = {}) {
  const unknown = Object.keys(update).filter((field) => !JOB_STATE_FIELDS.includes(field));
  if (unknown.length) {
    throw new Error(`Media queue job update contains unsupported fields: ${unknown.join(", ")}.`);
  }

  const safe = {};
  for (const field of JOB_STATE_FIELDS) {
    if (!Object.hasOwn(update, field)) continue;
    const value = update[field];
    if (["complete", "retryable", "withdrawn"].includes(field)) {
      if (typeof value !== "boolean") throw new Error(`Media queue ${field} must be boolean.`);
      safe[field] = value;
    } else if (field === "safetyFailure") {
      if (!["MEDIA_PROCESS_CLEANUP", "MEDIA_BROWSER_CLEANUP", "MEDIA_FILE_CLEANUP"].includes(value))
        throw new Error(
          "Media safety evidence must identify unconfirmed process, browser, or file cleanup; inspect the retained barrier before recovery.",
        );
      safe[field] = value;
    } else if (field === "attempts") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Media queue attempts must be a non-negative safe integer.");
      }
      safe[field] = value;
    } else if (field === "artifacts") {
      safe[field] = safeArtifacts(value);
    } else if (field === "transcript") {
      safe[field] = safeTranscript(value);
    } else if (field === "media") {
      safe[field] = safeMedia(value);
    } else if (field === "checkpoint") {
      safe[field] = safeCheckpoint(value);
    } else if (["limitations"].includes(field)) {
      if (!Array.isArray(value)) throw new Error("Media queue limitations must be an array.");
      safe[field] = value.map((limitation) => publicMediaError(String(limitation)));
    } else if (["sourceSha256", "formattedSha256"].includes(field)) {
      if (value !== null && !/^[0-9a-f]{64}$/i.test(String(value))) {
        throw new Error(`Media queue ${field} must be a SHA-256 digest.`);
      }
      safe[field] = value === null ? null : String(value).toLowerCase();
    } else if (["duration", "speechDuration"].includes(field)) {
      if (value !== null && !positiveDuration(value)) {
        if (dropInvalidDurations) continue;
        throw new Error(`Media queue ${field} must be a positive number.`);
      }
      safe[field] = value;
    } else if (field === "lastError" || field === "limitation") {
      if (value !== null && typeof value !== "string") {
        throw new Error(`Media queue ${field} must be a string or null.`);
      }
      safe[field] = value === null ? null : publicMediaError(value);
    } else {
      if (value !== null && typeof value !== "string") {
        throw new Error(`Media queue ${field} must be a string or null.`);
      }
      safe[field] = value === null ? null : publicMediaError(value);
    }
  }
  return safe;
}

function safeArtifacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Media queue artifacts must be an object.");
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([kind, path]) => {
      if (typeof path !== "string" || path.includes("\0") || /:\/\//.test(path)) return [];
      return [[kind, path]];
    }),
  );
}

function safeTranscript(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Media queue transcript state must be an object.");
  }
  const flags = Object.hasOwn(value, "flags") ? validateSourceReviewFlags(value.flags) : [];
  if (
    (value.reviewRequired === true && !flags.length) ||
    (flags.length &&
      (value.reviewRequired !== true || value.complete === true || value.formattedReady === true))
  )
    throw new Error("Transcript source review evidence must remain explicit and incomplete.");
  return {
    ...(typeof value.complete === "boolean" ? { complete: value.complete } : {}),
    ...(typeof value.sourceKind === "string"
      ? { sourceKind: publicMediaError(value.sourceKind) }
      : {}),
    ...(typeof value.language === "string" ? { language: publicMediaError(value.language) } : {}),
    ...(typeof value.reviewRequired === "boolean" ? { reviewRequired: value.reviewRequired } : {}),
    ...(Object.hasOwn(value, "flags") ? { flags: validateSourceReviewFlags(value.flags) } : {}),
    ...(typeof value.sourceRetained === "boolean" ? { sourceRetained: value.sourceRetained } : {}),
    ...(typeof value.formattedReady === "boolean" ? { formattedReady: value.formattedReady } : {}),
  };
}

function safeMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Media queue media state must be an object.");
  }
  return Object.fromEntries(
    ["video", "audio"].flatMap((kind) => {
      const media = value[kind];
      if (!media || typeof media !== "object" || Array.isArray(media)) return [];
      return [
        [
          kind,
          {
            ...(typeof media.available === "boolean" ? { available: media.available } : {}),
            ...(typeof media.path === "string" && !/:\/\//.test(media.path)
              ? { path: media.path }
              : {}),
            ...(media.quality === null || Number.isFinite(media.quality)
              ? { quality: media.quality }
              : {}),
            ...(typeof media.audio === "boolean" ? { audio: media.audio } : {}),
          },
        ],
      ];
    }),
  );
}

function safeCheckpoint(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Media queue checkpoint must be an object.");
  }
  if (typeof value.at !== "string" || typeof value.reason !== "string") {
    throw new Error("Media queue checkpoint needs an at time and reason.");
  }
  return { at: value.at, reason: publicMediaError(value.reason) };
}

async function persistQueueStatuses({
  course,
  discovery,
  queue,
  now,
  write,
  recording = null,
  boundary,
}) {
  if (!course?.destination) return null;
  const statusCourse = { ...course, destination: boundary.placementKey(course.destination) };
  const statusAppearance = (job) =>
    job.placement
      ? {
          ...job,
          placement: {
            ...job.placement,
            destination: boundary.placementKey(job.placement.destination),
          },
        }
      : job;
  const courseStatus = await writeMediaCourseStatus({
    course: statusCourse,
    discovery,
    queue: queue.map(statusAppearance),
    now,
    write,
  });
  if (recording) {
    await writeMediaRecordingStatus({
      appearance: statusAppearance(recording),
      job: statusAppearance(recording),
      now,
      write,
    });
  } else {
    for (const appearance of queue) {
      await writeMediaRecordingStatus({
        appearance: statusAppearance(appearance),
        job: statusAppearance(appearance),
        now,
        write,
      });
    }
  }
  return courseStatus;
}

function safeCourseKey(value) {
  const key = String(value ?? "");
  if (!key) throw new Error("Media queue needs a non-empty course key.");
  return encodeURIComponent(key);
}

function rejectPlacementCollisions(queue, boundary) {
  const collisions = mediaPlacementCollisions(queue, boundary);
  return queue.map((job) =>
    collisions.has(job.recordingId)
      ? {
          ...job,
          complete: false,
          stage: "failed",
          verdict: "red",
          retryable: false,
          transcript: { ...job.transcript, complete: false },
          limitations: [
            ...new Set([
              ...(job.limitations ?? []),
              "Established artifact placement is shared by distinct recordings. Artifacts retained; Owner review is required before acquisition.",
            ]),
          ],
        }
      : job,
  );
}

export function mediaPlacementCollisions(queue, boundary) {
  const claims = new Map();
  const collisions = new Set();
  for (const job of queue) {
    const placement = job.placement;
    if (!placement?.destination) continue;
    for (const field of ["videoPath", "audioPath", "formattedTranscriptPath", "statusPath"]) {
      if (!placement[field]) continue;
      const path =
        `${boundary.placementKey(placement.destination)}/${placement[field]}`.toLowerCase();
      const owner = claims.get(path);
      if (owner && owner !== job.recordingId) {
        collisions.add(owner);
        collisions.add(job.recordingId);
      }
      claims.set(path, job.recordingId);
    }
  }
  return collisions;
}
