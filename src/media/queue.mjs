import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { publicMediaError } from "./errors.mjs";
import { isMediaJobComplete } from "./completeness.mjs";
import { positiveDuration } from "./duration.mjs";
import { writeMediaCourseStatus, writeMediaRecordingStatus } from "./status.mjs";

const QUEUE_VERSION = 1;
const JOB_STATE_FIELDS = Object.freeze([
  "complete",
  "stage",
  "verdict",
  "retryable",
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
const EPHEMERAL_JOB_FIELDS = new Set([
  "resolved",
  "resolvedUrl",
  "sourceUrl",
  "session",
  "token",
  "signature",
  "cookies",
  "requestHeaders",
]);

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
  const existing = await readMediaQueue({ statePath, courseKey: course.key, course, read });
  if (discovery.complete !== true && existing.record) {
    const status = await persistQueueStatuses({
      course,
      discovery,
      queue: existing.record.queue,
      now,
      write,
    });
    return { path, status: "unchanged", statusPath: status?.path };
  }
  const discoveredQueue =
    discovery.complete === true && Array.isArray(discovery.queue) ? discovery.queue : [];
  assertQueueCourse(discoveredQueue, course, course.courseId);
  const reconciledQueue = mergeQueue(existing.record?.queue, discoveredQueue);
  const transition = withdrawal
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
      verdict: discovery.verdict ?? "red",
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
    now,
    write,
  });
  return { path, status: transition.status, statusPath: status?.path };
}

export function mediaQueuePath(statePath, courseKey) {
  return join(dirname(statePath), "media-queue", `${safeCourseKey(courseKey)}.json`);
}

export async function readMediaQueue({ statePath, courseKey, course = null, read = readFile }) {
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
  assertQueueCourse(record?.queue, course, record?.courseId);
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

  const loaded = await readMediaQueue({ statePath, courseKey, course, read });
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

function mergeQueue(previousQueue, discoveredQueue) {
  const previous = Array.isArray(previousQueue) ? previousQueue : [];
  const previousById = new Map(
    previous.filter((job) => job?.recordingId).map((job) => [job.recordingId, job]),
  );
  const discoveredIds = new Set(discoveredQueue.map((appearance) => appearance?.recordingId));
  const merged = discoveredQueue.map((appearance) => {
    const previous = previousById.get(appearance?.recordingId);
    if (!previous) return stripEphemeralFields(appearance);
    return {
      ...stripEphemeralFields(appearance),
      ...preservedState(previous),
      ...(previous.placement ? { placement: previous.placement } : {}),
    };
  });
  return rejectPlacementCollisions([
    ...merged,
    ...previous.filter((job) => job?.recordingId && !discoveredIds.has(job.recordingId)),
  ]);
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
  return {
    ...(typeof value.complete === "boolean" ? { complete: value.complete } : {}),
    ...(typeof value.sourceKind === "string"
      ? { sourceKind: publicMediaError(value.sourceKind) }
      : {}),
    ...(typeof value.language === "string" ? { language: publicMediaError(value.language) } : {}),
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

async function persistQueueStatuses({ course, discovery, queue, now, write, recording = null }) {
  if (!course?.destination) return null;
  const courseStatus = await writeMediaCourseStatus({ course, discovery, queue, now, write });
  if (recording) {
    await writeMediaRecordingStatus({
      appearance: recording,
      job: recording,
      now,
      write,
    });
  } else {
    for (const appearance of queue) {
      await writeMediaRecordingStatus({ appearance, job: appearance, now, write });
    }
  }
  return courseStatus;
}

function safeCourseKey(value) {
  const key = String(value ?? "");
  if (!key) throw new Error("Media queue needs a non-empty course key.");
  return encodeURIComponent(key);
}

function assertQueueCourse(queue, course, courseId) {
  for (const job of queue ?? []) {
    if (
      (job.courseId && job.courseId !== courseId) ||
      (course?.destination &&
        job.placement?.destination &&
        job.placement.destination !== course.destination)
    ) {
      throw new Error(
        "Media queue appearance belongs to another course or destination. Existing artifacts are retained; review the course configuration.",
      );
    }
  }
}

function rejectPlacementCollisions(queue) {
  const claims = new Map();
  const collisions = new Set();
  for (const job of queue) {
    const placement = job.placement;
    if (!placement?.destination) continue;
    for (const field of ["videoPath", "audioPath", "formattedTranscriptPath", "statusPath"]) {
      if (!placement[field]) continue;
      const path = `${placement.destination}/${placement[field]}`.toLowerCase();
      const owner = claims.get(path);
      if (owner && owner !== job.recordingId) {
        collisions.add(owner);
        collisions.add(job.recordingId);
      }
      claims.set(path, job.recordingId);
    }
  }
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
