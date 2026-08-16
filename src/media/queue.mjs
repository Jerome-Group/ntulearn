import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { publicMediaError } from "./errors.mjs";

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
  const existing = await readMediaQueue({ statePath, courseKey: course.key, read });
  if (discovery.complete !== true && existing.record) {
    return { path, status: "unchanged" };
  }
  const discoveredQueue =
    discovery.complete === true && Array.isArray(discovery.queue) ? discovery.queue : [];
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
  return { path, status: transition.status };
}

export function mediaQueuePath(statePath, courseKey) {
  return join(dirname(statePath), "media-queue", `${safeCourseKey(courseKey)}.json`);
}

export async function readMediaQueue({ statePath, courseKey, read = readFile }) {
  const path = mediaQueuePath(statePath, courseKey);
  const content = await read(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return { path, record: content ? JSON.parse(content) : null };
}

export async function updateMediaQueueJob({
  statePath,
  courseKey,
  recordingId,
  update,
  now = () => new Date(),
  write = writeAtomically,
  read = readFile,
}) {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Media queue job updates need an object.");
  }

  const loaded = await readMediaQueue({ statePath, courseKey, read });
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
    return jobIndex === index ? { ...durableJob, ...safeUpdate } : durableJob;
  });
  const record = { ...loaded.record, queue, updatedAt: now().toISOString() };
  await write(loaded.path, queueJson(record));
  return { path: loaded.path, record, job: queue[index] };
}

export function withdrawQueuedRecording({ queue, recordingId, confirmed }) {
  if (!Array.isArray(queue)) throw new Error("Media queue withdrawal needs a queue.");
  const index = queue.findIndex((job) => job?.recordingId === recordingId);
  if (index === -1) return { status: "not-found", queue };

  const current = queue[index];
  if (current.complete === true) return { status: "retained", queue };
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
    };
  });
  return [
    ...merged,
    ...previous.filter(
      (job) => job?.withdrawn === true && job.recordingId && !discoveredIds.has(job.recordingId),
    ),
  ];
}

function preservedState(job) {
  const state = Object.fromEntries(
    JOB_STATE_FIELDS.filter((field) => Object.hasOwn(job, field)).map((field) => [
      field,
      job[field],
    ]),
  );
  return sanitizeJobState(state);
}

function queueJson(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function stripEphemeralFields(job) {
  return Object.fromEntries(
    Object.entries(job).filter(([field]) => !EPHEMERAL_JOB_FIELDS.has(field)),
  );
}

function sanitizeJobState(update) {
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

function safeCourseKey(value) {
  const safe = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "course";
}
