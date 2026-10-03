import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { monitorMediaCapacity } from "./capacity-monitor.mjs";
import { recordingDisposition } from "./disposition.mjs";
import { randomUUID } from "node:crypto";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";
import { isGlobalMediaSafetyFailure, publicMediaError } from "./errors.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { readMediaQueue, updateMediaQueueJob } from "./queue.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { persistMediaDigest } from "./digest.mjs";
import { writeMediaCourseStatus, writeMediaRecordingStatus } from "./status.mjs";
import {
  courseSummary,
  discoveryIncompleteSummary,
  messageFor,
  missingQueueSummary,
  queueReadFailureSummary,
  summarizeCounts,
  verdictFor,
} from "./worker-report.mjs";
import {
  checkpointUpdate,
  failureUpdate,
  finishedJob,
  resultUpdate,
  mediaArtifactEvidenceUpdate,
} from "./worker-state.mjs";

export { mediaDigestPaths } from "./digest.mjs";

export const MEDIA_RUN_MODES = Object.freeze(["scheduled", "manual"]);
export const OVERNIGHT_START_HOUR = 0;
export const OVERNIGHT_END_HOUR = 4;

export function mediaWorkerExitCode(digest) {
  return digest?.verdict === "green" ? 0 : 1;
}

export async function runMediaQueue(options = {}) {
  const {
    statePath,
    courses,
    mode = "scheduled",
    signal,
    priorityCourseKey = null,
    runJob,
    preflight = null,
    media = null,
    lock = withMediaQueueLock,
    now = null,
    clock = null,
    write,
    runId = randomUUID(),
  } = options;
  assertRunInputs({ statePath, courses, mode, runJob, preflight, media, priorityCourseKey });
  if (!lock) return runMediaQueueUnlocked(options);

  const readNow = now ?? clock?.now?.bind(clock) ?? (() => new Date());
  try {
    return await lock({
      statePath,
      run: () => runMediaQueueUnlocked({ ...options, lock: null }),
    });
  } catch (error) {
    if (error?.code !== "MEDIA_QUEUE_LOCK_HELD") throw error;
    const startedAt = validDate(readNow(), "media queue start");
    const finishedAt = validDate(readNow(), "media queue finish");
    return persistMediaDigest({
      statePath,
      interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
      runId,
      mode,
      startedAt,
      finishedAt,
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
      interrupted: Boolean(signal?.aborted),
      verdict: "yellow",
      message: "Media queue skipped: another run is active.",
      summarizeCounts,
      write,
    });
  }
}

async function runMediaQueueUnlocked({
  statePath,
  courses,
  mode = "scheduled",
  signal,
  priorityCourseKey = null,
  closeJobRunner = null,
  runJob,
  preflight = null,
  checkCapacity = null,
  capacityMonitorIntervalMs = 1_000,
  capacityCheckTimeoutMs = 5_000,
  media = null,
  now = null,
  schedule = null,
  cancelSchedule = null,
  clock = null,
  timeZone = null,
  readQueue = readMediaQueue,
  updateJob = updateMediaQueueJob,
  write,
  runId = randomUUID(),
  startedAt: suppliedStartedAt = null,
}) {
  assertRunInputs({ statePath, courses, mode, runJob, preflight, media, priorityCourseKey });
  const readNow = now ?? clock?.now?.bind(clock) ?? (() => new Date());
  const setSchedule = schedule ?? clock?.setTimeout?.bind(clock) ?? scheduleTimer;
  const clearSchedule = cancelSchedule ?? clock?.clearTimeout?.bind(clock) ?? cancelTimer;
  const safetyCheck = preflight ?? (() => verifyMediaRuntime(media, { signal }));
  const startedAt = suppliedStartedAt ?? validDate(readNow(), "media queue start");
  const selectedCourses = courses.filter((course) => course?.mediaMode !== "off");
  if (priorityCourseKey) {
    const index = selectedCourses.findIndex((course) => course.key === priorityCourseKey);
    selectedCourses.unshift(...selectedCourses.splice(index, 1));
  }

  try {
    await assertMediaSafetyAdmission({ statePath, courses, readQueue });
  } catch (error) {
    for (const course of selectedCourses)
      await persistRedCourseStatus({ course, now: readNow, error });
    const summaries = [];
    for (const course of selectedCourses)
      summaries.push(await summarizeUnprocessedCourse({ statePath, course, readQueue, media }));
    return persistMediaDigest({
      statePath,
      interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: summaries,
      globalStop: true,
      stoppedAtBoundary: false,
      interrupted: Boolean(signal?.aborted),
      verdict: "red",
      message: publicMediaError(error),
      summarizeCounts,
      write,
    });
  }

  if (mode === "scheduled" && !isOvernightWindow(startedAt, timeZone)) {
    return persistMediaDigest({
      statePath,
      interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
      interrupted: Boolean(signal?.aborted),
      verdict: "yellow",
      message: "Scheduled media work skipped: outside the overnight window (00:00–04:00).",
      summarizeCounts,
      write,
    });
  }

  if (!selectedCourses.length) {
    return persistMediaDigest({
      statePath,
      interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
      interrupted: Boolean(signal?.aborted),
      verdict: signal?.aborted ? "yellow" : "green",
      message: signal?.aborted
        ? "Media queue interrupted; retry the manual worker."
        : "No enabled media courses are configured.",
      summarizeCounts,
      write,
    });
  }

  try {
    signal?.throwIfAborted();
    await safetyCheck({ mode, now: readNow, signal });
    signal?.throwIfAborted();
    if (!checkCapacity && media) {
      const capacity = await createMediaCapacity(media, {
        courses,
        timeoutMs: capacityCheckTimeoutMs,
      });
      checkCapacity = ({ course }) => capacity.checkJob(course);
    }
    signal?.throwIfAborted();
  } catch (error) {
    await persistMediaSafetyBarrier({ statePath, error, now: readNow });
    const interrupted = signal?.aborted && !isGlobalMediaSafetyFailure(error);
    const message = interrupted
      ? "Media queue interrupted before acquisition; retry the manual worker."
      : publicMediaError(error);
    if (!interrupted)
      await Promise.all(
        selectedCourses.map((course) =>
          persistRedCourseStatus({
            course,
            discovery: { complete: false, verdict: "red", limitations: [message] },
            queue: [],
            now: readNow,
          }),
        ),
      );
    const summaries = [];
    for (const course of selectedCourses) {
      summaries.push(await summarizeUnprocessedCourse({ statePath, course, readQueue, media }));
    }
    return persistMediaDigest({
      statePath,
      interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: summaries,
      globalStop: !interrupted,
      stoppedAtBoundary: false,
      interrupted: Boolean(signal?.aborted),
      verdict: interrupted
        ? verdictFor({
            summaries,
            counts: summarizeCounts(summaries),
            globalStop: false,
            stoppedAtBoundary: true,
          })
        : "red",
      message,
      summarizeCounts,
      write,
    });
  }

  const summaries = [];
  let globalStop = false;
  let stoppedAtBoundary = false;
  let interrupted = Boolean(signal?.aborted);

  for (const course of selectedCourses) {
    const outcome =
      globalStop || stoppedAtBoundary || interrupted
        ? {
            globalStop: false,
            stoppedAtBoundary: false,
            summary: await summarizeUnprocessedCourse({
              statePath,
              course,
              readQueue,
              media,
              updateJob: globalStop ? undefined : updateJob,
              now: readNow,
            }),
          }
        : await runCourse({
            statePath,
            course,
            mode,
            signal,
            runJob,
            checkCapacity,
            capacityMonitorIntervalMs,
            capacityCheckTimeoutMs,
            now: readNow,
            timeZone,
            schedule: setSchedule,
            cancelSchedule: clearSchedule,
            readQueue,
            updateJob,
            media,
          });
    summaries.push(outcome.summary);
    globalStop ||= outcome.globalStop;
    stoppedAtBoundary ||= outcome.stoppedAtBoundary;
    interrupted ||= Boolean(outcome.interrupted || signal?.aborted);
  }

  let settlementFailure;
  try {
    await closeJobRunner?.();
  } catch (error) {
    await persistMediaSafetyBarrier({ statePath, error, now: readNow });
    globalStop = true;
    settlementFailure = publicMediaError(error);
  }
  interrupted ||= Boolean(signal?.aborted);
  const finishedAt = validDate(readNow(), "media queue finish");
  const counts = summarizeCounts(summaries);
  let verdict = verdictFor({
    summaries,
    counts,
    globalStop,
    stoppedAtBoundary,
  });
  if (interrupted && verdict === "green") verdict = "yellow";
  return persistMediaDigest({
    statePath,
    interruptionReason: signal?.aborted ? publicMediaError(signal.reason) : undefined,
    runId,
    mode,
    startedAt,
    finishedAt,
    courses: summaries,
    counts,
    globalStop,
    stoppedAtBoundary,
    verdict,
    interrupted,
    message:
      settlementFailure ??
      (interrupted && !globalStop
        ? `Media queue interrupted: ${counts.completed} complete; pending work retained. Retry the manual worker.`
        : messageFor({ verdict, counts, globalStop, stoppedAtBoundary, summaries })),
    summarizeCounts,
    write,
  });
}

async function summarizeUnprocessedCourse({ statePath, course, readQueue, media, updateJob, now }) {
  try {
    const loaded = await readQueue({ statePath, courseKey: course.key, course });
    const record = loaded?.record;
    if (!record || !Array.isArray(record.queue)) return missingQueueSummary(course, loaded?.path);
    if (record.complete !== true) return discoveryIncompleteSummary(course, loaded.path, record);
    const queue = [];
    for (const job of record.queue) {
      const evidence = await mediaArtifactEvidenceUpdate(job, {
        mediaRoot: media?.mediaRoot,
        course,
      });
      if (evidence?.artifacts && updateJob) {
        const result = await persistJobUpdate({
          updateJob,
          statePath,
          course,
          job,
          update: evidence,
          now,
        });
        if (result.error) throw result.error;
        queue.push(result.job);
      } else queue.push({ ...job, ...evidence });
    }
    return courseSummary({
      course,
      queuePath: loaded.path,
      queue,
      processed: 0,
      discovery: record,
    });
  } catch (error) {
    return queueReadFailureSummary(course, publicMediaError(error));
  }
}

export function isOvernightWindow(value, timeZone = null) {
  const date = validDate(value, "overnight-window check");
  const hour = localHour(date, timeZone);
  return hour >= OVERNIGHT_START_HOUR && hour < OVERNIGHT_END_HOUR;
}

export function nextOvernightBoundary(value, timeZone = null) {
  const date = validDate(value, "overnight boundary");
  if (timeZone) return zonedBoundary(date, timeZone);
  const boundary = new Date(date);
  boundary.setHours(OVERNIGHT_END_HOUR, 0, 0, 0);
  if (boundary <= date) boundary.setDate(boundary.getDate() + 1);
  return boundary;
}

async function runCourse({
  statePath,
  course,
  mode,
  signal,
  runJob,
  checkCapacity,
  capacityMonitorIntervalMs,
  capacityCheckTimeoutMs,
  now,
  schedule,
  cancelSchedule,
  readQueue,
  updateJob,
  timeZone,
  media,
}) {
  let loaded;
  try {
    loaded = await readQueue({ statePath, courseKey: course.key, course });
  } catch (error) {
    await persistRedCourseStatus({
      course,
      discovery: { complete: false, verdict: "red" },
      queue: [],
      now,
      error,
    });
    return {
      globalStop: isGlobalMediaSafetyFailure(error),
      stoppedAtBoundary: false,
      summary: queueReadFailureSummary(course, publicMediaError(error)),
    };
  }
  const record = loaded?.record;
  if (!record || !Array.isArray(record.queue)) {
    await persistRedCourseStatus({
      course,
      discovery: {
        complete: false,
        verdict: "red",
        limitations: [`No durable media queue exists for ${course.key}.`],
      },
      queue: [],
      now,
    });
    return {
      globalStop: false,
      stoppedAtBoundary: false,
      summary: missingQueueSummary(course, loaded?.path),
    };
  }
  if (record.complete !== true) {
    await writeMediaCourseStatus({ course, discovery: record, queue: record.queue, now });
    return {
      globalStop: false,
      stoppedAtBoundary: false,
      summary: discoveryIncompleteSummary(course, loaded.path, record),
    };
  }

  const queue = record.queue.map((job) => ({ ...job }));
  let processed = 0;
  let globalStop = false;
  let stoppedAtBoundary = false;
  let interrupted = false;

  for (const job of queue) {
    if (signal?.aborted) {
      interrupted = true;
      break;
    }
    if (recordingDisposition(job) !== "recording") continue;
    let evidence;
    try {
      evidence = await mediaArtifactEvidenceUpdate(job, { mediaRoot: media?.mediaRoot, course });
      if (evidence) {
        const reconciled = await persistJobUpdate({
          updateJob,
          statePath,
          course,
          job,
          update: evidence,
          now,
        });
        Object.assign(job, reconciled.job);
      }
    } catch (error) {
      globalStop = true;
      await persistRedCourseStatus({ course, discovery: record, queue, now, error });
      break;
    }
    if (finishedJob(job)) continue;
    if (signal?.aborted) {
      interrupted = true;
      break;
    }
    if (mode === "scheduled" && !isOvernightWindow(now(), timeZone)) {
      stoppedAtBoundary = true;
      break;
    }

    const startedAt = validDate(now(), "media job start");
    const attempts = (Number.isSafeInteger(job.attempts) ? job.attempts : 0) + 1;
    const active = await persistJobUpdate({
      updateJob,
      statePath,
      course,
      job,
      update: {
        stage: "active",
        startedAt: startedAt.toISOString(),
        attempts,
        lastError: null,
        checkpoint: null,
      },
      now,
    }).catch((error) => {
      globalStop = true;
      return { error };
    });
    if (active.error) {
      await persistRedCourseStatus({ course, discovery: record, queue, now, error: active.error });
      break;
    }
    Object.assign(job, active.job);

    const controller = new globalThis.AbortController();
    const interrupt = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    let checkpointRequested = false;
    let timer = null;
    const requestCheckpoint = (reason = "04:00 checkpoint") => {
      if (checkpointRequested) return;
      checkpointRequested = true;
      const error = new Error(reason);
      error.code = "MEDIA_CHECKPOINT";
      controller.abort(error);
    };
    if (mode === "scheduled") {
      const delay = Math.max(
        0,
        nextOvernightBoundary(startedAt, timeZone).getTime() - startedAt.getTime(),
      );
      timer = schedule(requestCheckpoint, delay);
    }

    let result;
    let failure;
    let capacityFailure = null;
    let stopMonitoring = null;
    const probeCapacity = checkCapacity
      ? () =>
          withCapacityDeadline(() => checkCapacity({ job, course }), {
            timeoutMs: capacityCheckTimeoutMs,
          })
      : null;
    try {
      controller.signal.throwIfAborted();
      await probeCapacity?.();
      controller.signal.throwIfAborted();
      if (checkCapacity) {
        stopMonitoring = monitorMediaCapacity(probeCapacity, {
          intervalMs: capacityMonitorIntervalMs,
          timeoutMs: capacityCheckTimeoutMs,
          onFailure: (error) => {
            capacityFailure = error;
            controller.abort(error);
          },
        });
      }
      result = await runJob(job, {
        course,
        mode,
        signal: controller.signal,
        now,
        requestCheckpoint,
      });
      await probeCapacity?.();
    } catch (error) {
      failure = error;
    } finally {
      if (timer !== null && timer !== undefined) cancelSchedule(timer);
      await stopMonitoring?.();
      signal?.removeEventListener("abort", interrupt);
    }
    failure = isGlobalMediaSafetyFailure(failure) ? failure : (capacityFailure ?? failure);

    const finishedAt = validDate(now(), "media job finish");
    if (isGlobalMediaSafetyFailure(failure)) {
      await persistMediaSafetyBarrier({ statePath, error: failure, now });
      const failed = await persistJobUpdate({
        updateJob,
        statePath,
        course,
        job,
        update: failureUpdate(failure, finishedAt),
        now,
      }).catch((error) => ({ error }));
      if (failed.error) {
        await persistRedCourseStatus({ course, discovery: record, queue, now, error: failure });
      } else {
        Object.assign(job, failed.job);
      }
      globalStop = true;
      break;
    }
    if (signal?.aborted) {
      interrupted = true;
      const saved = await persistJobUpdate({
        updateJob,
        statePath,
        course,
        job,
        now,
        update: checkpointUpdate({
          result,
          failure: signal.reason,
          finishedAt,
          reason: `${mode} interruption`,
        }),
      }).catch((error) => ({ error }));
      if (saved.error) {
        globalStop = true;
        await persistRedCourseStatus({ course, discovery: record, queue, now, error: saved.error });
      } else Object.assign(job, saved.job);
      break;
    }
    if (checkpointRequested || (mode === "scheduled" && !isOvernightWindow(finishedAt, timeZone))) {
      const checkpoint = await persistJobUpdate({
        updateJob,
        statePath,
        course,
        job,
        update: checkpointUpdate({ result, failure, finishedAt }),
        now,
      }).catch((error) => ({ error }));
      if (checkpoint.error) {
        globalStop = true;
        await persistRedCourseStatus({
          course,
          discovery: record,
          queue,
          now,
          error: checkpoint.error,
        });
      } else Object.assign(job, checkpoint.job);
      stoppedAtBoundary = !globalStop;
      break;
    }

    processed += 1;
    if (failure !== undefined) {
      const failed = await persistJobUpdate({
        updateJob,
        statePath,
        course,
        job,
        update: failureUpdate(failure, finishedAt),
        now,
      }).catch((error) => ({ error }));
      if (failed.error) {
        globalStop = true;
        await persistRedCourseStatus({
          course,
          discovery: record,
          queue,
          now,
          error: failed.error,
        });
      } else Object.assign(job, failed.job);
      if (globalStop) break;
      continue;
    }

    const update = resultUpdate(result, finishedAt);
    let evidenceAfterRun;
    try {
      evidenceAfterRun = await mediaArtifactEvidenceUpdate(
        { ...job, ...update },
        { mediaRoot: media?.mediaRoot, course },
      );
    } catch (error) {
      evidenceAfterRun = failureUpdate(error, finishedAt);
      globalStop = isGlobalMediaSafetyFailure(error);
    }
    const completed = await persistJobUpdate({
      updateJob,
      statePath,
      course,
      job,
      update: { ...update, ...evidenceAfterRun },
      now,
    }).catch((error) => ({ error }));
    if (completed.error) {
      globalStop = true;
      await persistRedCourseStatus({
        course,
        discovery: record,
        queue,
        now,
        error: completed.error,
      });
    } else Object.assign(job, completed.job);
    if (globalStop) break;
  }

  if (!globalStop) {
    try {
      await writeMediaCourseStatus({
        course,
        discovery: record,
        queue,
        now,
        mediaRoot: media?.mediaRoot,
      });
      for (const job of queue) {
        if (job.placement?.statusPath)
          await writeMediaRecordingStatus({ appearance: job, now, mediaRoot: media?.mediaRoot });
      }
    } catch (error) {
      globalStop = true;
      await persistRedCourseStatus({ course, discovery: record, queue, now, error });
    }
  }

  return {
    globalStop,
    stoppedAtBoundary,
    interrupted,
    summary: courseSummary({
      course,
      queuePath: loaded.path,
      queue,
      processed,
      discovery: record,
    }),
  };
}

async function persistJobUpdate({ updateJob, statePath, course, job, update, now }) {
  return updateJob({
    statePath,
    courseKey: course.key,
    recordingId: job.recordingId,
    course,
    update,
    now,
  });
}

async function persistRedCourseStatus({ course, discovery = {}, queue = [], now, error = null }) {
  const limitations = [
    ...(Array.isArray(discovery.limitations) ? discovery.limitations : []),
    ...(error ? [publicMediaError(error)] : []),
  ];
  await writeMediaCourseStatus({
    course,
    discovery: {
      ...discovery,
      complete: false,
      verdict: "red",
      limitations: [...new Set(limitations)],
    },
    queue,
    now,
  }).catch(() => null);
}

function assertRunInputs({
  statePath,
  courses,
  mode,
  runJob,
  preflight,
  media,
  priorityCourseKey,
}) {
  if (typeof statePath !== "string" || !statePath)
    throw new Error("Media queue needs a state path.");
  if (!Array.isArray(courses)) throw new Error("Media queue needs configured courses.");
  if (!MEDIA_RUN_MODES.includes(mode)) {
    throw new Error("Media queue mode must be scheduled or manual.");
  }
  if (
    priorityCourseKey !== null &&
    priorityCourseKey !== undefined &&
    (mode !== "manual" ||
      typeof priorityCourseKey !== "string" ||
      !courses.some((course) => course.key === priorityCourseKey && course.mediaMode !== "off"))
  ) {
    throw new Error(
      "Manual media priority needs an enabled configured course. Run: npm run media:worker -- manual [priority-course]",
    );
  }
  if (typeof runJob !== "function") {
    throw new Error("Media queue needs a provider-backed job runner.");
  }
  if (typeof preflight !== "function" && !media) {
    throw new Error("Media queue needs a media runtime preflight.");
  }
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date;
}

function localHour(date, timeZone) {
  if (!timeZone) return date.getHours();
  return Number(localParts(date, timeZone).hour);
}

function zonedBoundary(date, timeZone) {
  const parts = localParts(date, timeZone);
  const localDate = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + (Number(parts.hour) >= OVERNIGHT_END_HOUR ? 1 : 0),
    OVERNIGHT_END_HOUR,
  );
  let boundary = new Date(localDate);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    boundary = new Date(localDate - timeZoneOffset(boundary, timeZone));
  }
  return boundary;
}

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
}

function timeZoneOffset(date, timeZone) {
  const parts = localParts(date, timeZone);
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return local - date.getTime();
}
