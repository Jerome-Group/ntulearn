import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomically } from "../atomic.mjs";

const QUEUE_VERSION = 1;

export async function writeMediaQueue({
  statePath,
  course,
  discovery,
  withdrawal = null,
  now = () => new Date(),
  write = writeAtomically,
}) {
  const path = mediaQueuePath(statePath, course.key);
  const existing = await readMediaQueue({ statePath, courseKey: course.key });
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
    `${JSON.stringify(
      {
        version: QUEUE_VERSION,
        courseKey: course.key,
        courseId: course.courseId,
        complete: discovery.complete === true,
        verdict: discovery.verdict ?? "red",
        displayedCount: discovery.displayedCount ?? null,
        discoveredCount: discovery.discoveredCount ?? 0,
        queue,
        limitations: discovery.limitations ?? [],
        updatedAt: now().toISOString(),
      },
      null,
      2,
    )}\n`,
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
    if (!previous) return appearance;
    return {
      ...appearance,
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
  return Object.fromEntries(
    [
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
      "asr",
      "checkpoint",
    ]
      .filter((field) => Object.hasOwn(job, field))
      .map((field) => [field, job[field]]),
  );
}

function safeCourseKey(value) {
  const safe = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "course";
}
