import { randomUUID } from "node:crypto";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";
import { isGlobalMediaSafetyFailure, publicMediaError } from "./errors.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { readMediaQueue, updateMediaQueueJob } from "./queue.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { persistMediaDigest } from "./digest.mjs";
import { writeMediaCourseStatus } from "./status.mjs";
import {
  courseSummary,
  discoveryIncompleteSummary,
  messageFor,
  missingQueueSummary,
  queueReadFailureSummary,
  summarizeCounts,
  verdictFor,
} from "./worker-report.mjs";
import { checkpointUpdate, failureUpdate, finishedJob, resultUpdate } from "./worker-state.mjs";

export { mediaDigestPaths } from "./digest.mjs";

export const MEDIA_RUN_MODES = Object.freeze(["scheduled", "manual"]);
export const OVERNIGHT_START_HOUR = 0;
export const OVERNIGHT_END_HOUR = 4;

export async function runMediaQueue(options = {}) {
  const {
    statePath,
    courses,
    mode = "scheduled",
    runJob,
    preflight = null,
    media = null,
    lock = withMediaQueueLock,
    now = null,
    clock = null,
    write,
    runId = randomUUID(),
  } = options;
  assertRunInputs({ statePath, courses, mode, runJob, preflight, media });
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
      runId,
      mode,
      startedAt,
      finishedAt,
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
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
  runJob,
  preflight = null,
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
  assertRunInputs({ statePath, courses, mode, runJob, preflight, media });
  const readNow = now ?? clock?.now?.bind(clock) ?? (() => new Date());
  const setSchedule = schedule ?? clock?.setTimeout?.bind(clock) ?? scheduleTimer;
  const clearSchedule = cancelSchedule ?? clock?.clearTimeout?.bind(clock) ?? cancelTimer;
  const safetyCheck = preflight ?? (() => verifyMediaRuntime(media));
  const startedAt = suppliedStartedAt ?? validDate(readNow(), "media queue start");
  const selectedCourses = courses.filter((course) => course?.mediaMode !== "off");

  if (mode === "scheduled" && !isOvernightWindow(startedAt, timeZone)) {
    return persistMediaDigest({
      statePath,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
      verdict: "yellow",
      message: "Scheduled media work skipped: outside the overnight window (00:00–04:00).",
      summarizeCounts,
      write,
    });
  }

  if (!selectedCourses.length) {
    return persistMediaDigest({
      statePath,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: [],
      globalStop: false,
      stoppedAtBoundary: false,
      verdict: "green",
      message: "No enabled media courses are configured.",
      summarizeCounts,
      write,
    });
  }

  try {
    await safetyCheck({ mode, now: readNow });
  } catch (error) {
    const message = publicMediaError(error);
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
    return persistMediaDigest({
      statePath,
      runId,
      mode,
      startedAt,
      finishedAt: validDate(readNow(), "media queue finish"),
      courses: [],
      globalStop: true,
      stoppedAtBoundary: false,
      verdict: "red",
      message,
      summarizeCounts,
      write,
    });
  }

  const summaries = [];
  let globalStop = false;
  let stoppedAtBoundary = false;

  for (const course of selectedCourses) {
    const outcome = await runCourse({
      statePath,
      course,
      mode,
      runJob,
      now: readNow,
      timeZone,
      schedule: setSchedule,
      cancelSchedule: clearSchedule,
      readQueue,
      updateJob,
    });
    summaries.push(outcome.summary);
    globalStop ||= outcome.globalStop;
    stoppedAtBoundary ||= outcome.stoppedAtBoundary;
    if (globalStop || stoppedAtBoundary) break;
  }

  const finishedAt = validDate(readNow(), "media queue finish");
  const counts = summarizeCounts(summaries);
  const verdict = verdictFor({
    summaries,
    counts,
    globalStop,
    stoppedAtBoundary,
  });
  return persistMediaDigest({
    statePath,
    runId,
    mode,
    startedAt,
    finishedAt,
    courses: summaries,
    counts,
    globalStop,
    stoppedAtBoundary,
    verdict,
    message: messageFor({ verdict, counts, globalStop, stoppedAtBoundary, summaries }),
    summarizeCounts,
    write,
  });
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
  runJob,
  now,
  schedule,
  cancelSchedule,
  readQueue,
  updateJob,
  timeZone,
}) {
  let loaded;
  try {
    loaded = await readQueue({ statePath, courseKey: course.key });
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

  for (const job of queue) {
    if (finishedJob(job)) continue;
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
    let failure = null;
    try {
      result = await runJob(job, {
        course,
        mode,
        signal: controller.signal,
        now,
        requestCheckpoint,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (timer !== null && timer !== undefined) cancelSchedule(timer);
    }

    const finishedAt = validDate(now(), "media job finish");
    if (failure && isGlobalMediaSafetyFailure(failure)) {
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
    if (failure) {
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

    const completed = await persistJobUpdate({
      updateJob,
      statePath,
      course,
      job,
      update: resultUpdate(result, finishedAt),
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

  return {
    globalStop,
    stoppedAtBoundary,
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

function assertRunInputs({ statePath, courses, mode, runJob, preflight, media }) {
  if (typeof statePath !== "string" || !statePath)
    throw new Error("Media queue needs a state path.");
  if (!Array.isArray(courses)) throw new Error("Media queue needs configured courses.");
  if (!MEDIA_RUN_MODES.includes(mode)) {
    throw new Error("Media queue mode must be scheduled or manual.");
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
