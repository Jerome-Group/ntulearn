import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { writeAtomically } from "../atomic.mjs";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import { recordingDisposition } from "./disposition.mjs";
import {
  isGlobalMediaSafetyFailure,
  publicMediaError,
  GLOBAL_MEDIA_ERROR_CODES,
  unconfirmedMediaCleanupCode,
} from "./errors.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import {
  EPHEMERAL_MEDIA_JOB_FIELDS,
  mediaQueuePath,
  readMediaQueue,
  updateMediaQueueJob,
} from "./queue.mjs";
import { CATALOGUE_METADATA_LIMITS, parseCatalogueMetadata } from "./catalogue-safety.mjs";
import { closeMediaProbeHandle, withMediaProbeSettlement } from "./probe-settlement.mjs";

export const MEDIA_RETRY_CONFIRMATION = "RETRY_FAILED_MEDIA";
const LIMITS = { courses: 256, jobs: 20_000, queueBytes: 4 * 1024 * 1024, readMs: 5_000 };
const QUEUE_METADATA_LIMITS = Object.freeze({
  ...CATALOGUE_METADATA_LIMITS,
  bytes: LIMITS.queueBytes,
});
const FORBIDDEN_QUEUE_KEYS = Object.freeze([
  ...EPHEMERAL_MEDIA_JOB_FIELDS,
  "ks",
  "access_token",
  "id_token",
  "launch_token",
  "launch",
  "cookie",
  "state",
  "sig",
]);
const ACTION =
  "Inspect the selected failed recordings, course boundaries and private safety evidence; resolve uncertain cleanup before explicitly retrying. Existing artifacts and failure history are retained.";

export async function retryMediaJobs(
  { mode, config, courseKey, selector, confirmation },
  {
    assertAdmission = assertMediaSafetyAdmission,
    readQueue = readMediaQueue,
    updateJob = updateMediaQueueJob,
    lock = withMediaQueueLock,
    now = () => new Date(),
    read = readRetryQueueMetadata,
    write = writeAtomically,
    persistBarrier = persistMediaSafetyBarrier,
  } = {},
) {
  const counts = { courses: 0, inspected: 0, selected: 0, alreadyRetryable: 0, changed: 0 };
  let executionCleanupCode = null;
  try {
    if (
      !["plan", "apply"].includes(mode) ||
      typeof courseKey !== "string" ||
      !courseKey ||
      typeof selector !== "string" ||
      !selector ||
      selector.length > 4096 ||
      !Array.isArray(config?.courses) ||
      typeof config.statePath !== "string"
    )
      throw refusal("MEDIA_RETRY_ARGUMENTS");
    if (mode === "apply" && confirmation !== MEDIA_RETRY_CONFIRMATION)
      throw refusal("MEDIA_RETRY_CONFIRMATION_REQUIRED");
    const courses = config.courses.filter((course) =>
      courseKey === "all" ? course.mediaMode !== "off" : course.key === courseKey,
    );
    if (
      !courses.length ||
      courses.length > LIMITS.courses ||
      (courseKey !== "all" && courses.length !== 1) ||
      new Set(courses.map((course) => course.key.toLowerCase())).size !== courses.length
    )
      throw refusal("MEDIA_RETRY_COURSE_SELECTION");
    if (courses.some((course) => course.mediaMode === "off"))
      throw refusal("MEDIA_RETRY_COURSE_DISABLED");
    const execute = async () => {
      await assertAdmission({
        statePath: config.statePath,
        courses: config.courses,
        readQueue: (options) => readQueue({ ...options, read }),
      });
      const selected = [];
      const identities = new Set();
      for (const course of courses) {
        if (!course.courseId || !course.destination) throw refusal("MEDIA_RETRY_COURSE_BOUNDARY");
        const loaded = await readQueue({
          statePath: config.statePath,
          courseKey: course.key,
          course,
          read,
        });
        assertQueue(loaded.record, course);
        counts.courses++;
        counts.inspected += loaded.record.queue.length;
        if (counts.inspected > LIMITS.jobs) throw refusal("MEDIA_RETRY_JOB_LIMIT");
        for (const job of loaded.record.queue) {
          if (identities.has(job.recordingId)) throw refusal("MEDIA_RETRY_AMBIGUOUS_IDENTITY");
          identities.add(job.recordingId);
          const target =
            selector === "failed"
              ? recordingDisposition(job) === "recording" && job.stage === "failed"
              : job.recordingId === selector;
          if (!target) continue;
          assertTarget(job, course);
          selected.push({ course, job });
        }
      }
      if (selector !== "failed" && selected.length !== 1)
        throw refusal("MEDIA_RETRY_TARGET_NOT_FOUND");
      counts.selected = selected.length;
      counts.alreadyRetryable = selected.filter(({ job }) => job.retryable === true).length;
      if (mode === "apply") {
        const at = now().toISOString();
        const evidence = publicMediaError(
          `Explicit Owner retry permission granted at ${at}; prior failure and artifacts retained. Retry success and media completeness remain unverified.`,
        );
        for (const { course, job } of selected.filter(({ job }) => job.retryable === false)) {
          let durable = false;
          const currentRead = async (path) => {
            const content = await read(path);
            const record = JSON.parse(content);
            assertQueue(record, course);
            const matches = record.queue.filter((item) => item.recordingId === job.recordingId);
            if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(job))
              throw refusal("MEDIA_RETRY_TARGET_CHANGED");
            assertTarget(matches[0], course);
            return content;
          };
          try {
            await updateJob({
              statePath: config.statePath,
              courseKey: course.key,
              course,
              recordingId: job.recordingId,
              update: { retryable: true, limitations: [evidence] },
              now,
              read: currentRead,
              write: async (path, body) => {
                await write(path, body);
                if (path === mediaQueuePath(config.statePath, course.key)) {
                  durable = true;
                  counts.changed++;
                }
              },
            });
          } catch (error) {
            if (durable)
              throw Object.assign(refusal("MEDIA_RETRY_PUBLICATION_PARTIAL"), { cause: error });
            throw error;
          }
        }
      }
      return outcome(
        "passed",
        mode === "plan" ? "MEDIA_RETRY_PLAN" : "MEDIA_RETRY_APPLIED",
        counts,
        mode,
      );
    };
    const executeWithCleanupEvidence = async () => {
      try {
        return await execute();
      } catch (error) {
        // Lock barrier-storage failure can replace the thrown error; retain its closed cleanup code.
        executionCleanupCode = unconfirmedMediaCleanupCode(error);
        throw error;
      }
    };
    return mode === "apply"
      ? await lock({ statePath: config.statePath, run: executeWithCleanupEvidence })
      : await executeWithCleanupEvidence();
  } catch (caught) {
    let error = caught;
    const cleanupCode = unconfirmedMediaCleanupCode(error) ?? executionCleanupCode;
    let barrierPersistence = error?.code === "MEDIA_SAFETY_BARRIER_WRITE" ? "failed" : "unrun";
    if (cleanupCode && barrierPersistence !== "failed") {
      try {
        await persistBarrier({ statePath: config.statePath, error, now });
        barrierPersistence = "passed";
      } catch (barrierError) {
        error = barrierError;
        barrierPersistence = "failed";
      }
    }
    const code =
      (error?.code === "MEDIA_SAFETY_BARRIER_WRITE"
        ? error.code
        : (cleanupCode ?? retryRefusalCode(error))) ??
      (error?.code === "MEDIA_SAFETY_BARRIER"
        ? "MEDIA_RETRY_SAFETY_BARRIER"
        : error?.code === "MEDIA_QUEUE_LOCK_HELD"
          ? "MEDIA_RETRY_LOCK_HELD"
          : "MEDIA_RETRY_EVIDENCE_UNAVAILABLE");
    return outcome(counts.changed ? "failed" : "blocked", code, counts, mode, {
      ...(cleanupCode || error?.code === "MEDIA_SAFETY_BARRIER_WRITE"
        ? {
            cleanup: "unconfirmed",
            cleanupCode,
            safetyUnconfirmed: true,
            containmentRequired: true,
            barrierPersistence,
            physicalIoCancellation: "unclaimed",
          }
        : {}),
    });
  }
}

function assertQueue(record, course) {
  if (
    !record ||
    record.version !== 1 ||
    record.complete !== true ||
    !Array.isArray(record.queue) ||
    typeof record.courseKey !== "string" ||
    record.courseKey.toLowerCase() !== course.key.toLowerCase() ||
    record.courseId !== course.courseId ||
    record.queue.length > LIMITS.jobs
  )
    throw refusal("MEDIA_RETRY_QUEUE_UNAVAILABLE");
  assertQueueMetadata(Buffer.from(JSON.stringify(record)));
  const ids = new Set();
  for (const job of record.queue) {
    if (
      !job ||
      typeof job !== "object" ||
      Array.isArray(job) ||
      typeof job.recordingId !== "string" ||
      !job.recordingId ||
      job.recordingId.length > 4096 ||
      ids.has(job.recordingId) ||
      EPHEMERAL_MEDIA_JOB_FIELDS.some((key) => Object.hasOwn(job, key)) ||
      (job.limitations !== undefined &&
        (!Array.isArray(job.limitations) ||
          job.limitations.some((value) => typeof value !== "string"))) ||
      (job.retryable !== undefined && typeof job.retryable !== "boolean")
    )
      throw refusal("MEDIA_RETRY_QUEUE_MALFORMED");
    ids.add(job.recordingId);
  }
}

function assertTarget(job, course) {
  if (
    recordingDisposition(job) !== "recording" ||
    !["kaltura", "youtube", "direct"].includes(job.provider) ||
    typeof job.providerReference !== "string" ||
    !job.providerReference ||
    job.withdrawn ||
    job.stage !== "failed" ||
    job.complete === true ||
    ![true, false].includes(job.retryable) ||
    !["content-tree", "media-gallery"].some((surface) =>
      job.recordingId.startsWith(`${surface}:${course.courseId}:`),
    )
  )
    throw refusal("MEDIA_RETRY_TARGET_INELIGIBLE");
  if (unsafeEvidence(job)) throw refusal("MEDIA_RETRY_SAFETY_UNCONFIRMED");
}

function unsafeEvidence(job) {
  if (job.safetyFailure !== undefined && job.safetyFailure !== null && job.safetyFailure !== "")
    return true;
  if (unconfirmedGlobalFailure(job) || unconfirmedGlobalFailure(job.error)) return true;
  const text = [job.lastError, job.limitation, ...(job.limitations ?? [])].join("\n");
  return /MEDIA_(?:PROCESS|BROWSER)_CLEANUP|global.?safety|owned process.group cleanup|cleanup could not be confirmed/i.test(
    text,
  );
}

function unconfirmedGlobalFailure(error) {
  if (!error || typeof error !== "object") return false;
  const capacityCode =
    GLOBAL_MEDIA_ERROR_CODES.includes(error.code) && error.code !== "MEDIA_GLOBAL_SAFETY";
  if (isGlobalMediaSafetyFailure(error) && !capacityCode && !error.cause) return true;
  if (error.globalSafety === true && !capacityCode) return true;
  if (
    ["MEDIA_PROCESS_CLEANUP", "MEDIA_BROWSER_CLEANUP", "MEDIA_GLOBAL_SAFETY"].includes(error.code)
  )
    return true;
  return unconfirmedGlobalFailure(error.cause);
}

function refusal(code) {
  return Object.assign(new Error(ACTION), { retryCode: code });
}

function retryRefusalCode(error) {
  return error?.retryCode ?? (error?.cause ? retryRefusalCode(error.cause) : undefined);
}

function outcome(status, code, counts, mode, safety = {}) {
  return capabilityResult(
    "media:retry",
    [
      observation(
        "retry-permission",
        status,
        code,
        status === "passed"
          ? "Explicit retry permission only; no acquisition, transcription or completeness verdict changed."
          : "Retry permission refused or partially published; no raw private evidence exposed.",
        status === "passed" ? null : retryAction(code),
      ),
    ],
    {
      ...counts,
      mode: mode === "apply" ? "apply" : "plan",
      retrySucceeded: "unrun",
      mediaCompleteness: "unclaimed",
      ...safety,
    },
  );
}

function retryAction(code) {
  if (code === "MEDIA_FILE_CLEANUP" || code === "MEDIA_SAFETY_BARRIER_WRITE")
    return "Retain external containment and preserved safety evidence. Confirm owned pending file I/O and descriptor closure before any new admission; a barrier write failure requires continued external containment. Do not retry or clear safety evidence automatically.";
  if (code === "MEDIA_RETRY_SAFETY_BARRIER")
    return "Retained or unreadable safety evidence blocks all retry admission. The Owner must verify owned process/browser cessation and inspect evidence before explicitly clearing the barrier and queue safety markers; do not automatically retry.";
  if (code === "MEDIA_RETRY_CONFIRMATION_REQUIRED")
    return `Review plan, then provide literal confirmation ${MEDIA_RETRY_CONFIRMATION}.`;
  if (code === "MEDIA_RETRY_COURSE_DISABLED")
    return "Selected course has opted out of media. Restore explicit Owner media opt-in before requesting retry.";
  if (code === "MEDIA_RETRY_LOCK_HELD")
    return "Another media operation owns the queue lock. Wait for it to finish, then retry; do not reclaim its lock.";
  if (code === "MEDIA_RETRY_QUEUE_UNAVAILABLE")
    return "Restore complete, available discovery authority for selected courses before granting retry permission; existing artifacts are retained.";
  if (code === "MEDIA_RETRY_TARGET_NOT_FOUND")
    return "Select exactly one known failed recording identity, or use the explicit failed selector; missing targets remain unchanged.";
  return ACTION;
}

function assertQueueMetadata(content) {
  try {
    return parseCatalogueMetadata(content, {
      limits: QUEUE_METADATA_LIMITS,
      forbiddenKeys: FORBIDDEN_QUEUE_KEYS,
    });
  } catch (error) {
    throw refusal(
      error.code === "CATALOGUE_METADATA_LIMIT"
        ? "MEDIA_RETRY_QUEUE_BOUND"
        : "MEDIA_RETRY_QUEUE_UNSAFE",
    );
  }
}

export async function readRetryQueueMetadata(
  path,
  { openQueue = open, timeoutMs = LIMITS.readMs } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.readMs)
    throw refusal("MEDIA_RETRY_READ_TIMEOUT");
  return withMediaProbeSettlement(
    async (active) => {
      active();
      const handle = await openQueue(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        active();
        const before = await handle.stat();
        active();
        if (!before.isFile() || before.size > LIMITS.queueBytes)
          throw refusal("MEDIA_RETRY_QUEUE_BOUND");
        const parts = [],
          buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          active();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          active();
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > before.size || bytes > LIMITS.queueBytes)
            throw refusal("MEDIA_RETRY_QUEUE_BOUND");
          parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const after = await handle.stat();
        active();
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw refusal("MEDIA_RETRY_QUEUE_CHANGED");
        const content = Buffer.concat(parts);
        assertQueueMetadata(content);
        return content;
      } finally {
        await closeMediaProbeHandle(handle);
      }
    },
    { timeoutMs, timeoutError: refusal("MEDIA_RETRY_READ_TIMEOUT") },
  );
}
