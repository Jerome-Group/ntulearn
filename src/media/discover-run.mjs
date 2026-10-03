import { setTimeout, clearTimeout } from "node:timers";
import { selectCourses } from "../config.mjs";
import { CourseRefused } from "../ntulearn/read.mjs";
import { discoverCourseMedia } from "./workflow.mjs";
import { isMediaCourseEnabled } from "./gallery.mjs";
import { readMediaQueue, writeMediaQueue } from "./queue.mjs";
import { writeMediaCourseStatus } from "./status.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { markGlobalMediaSafety, isGlobalMediaSafetyFailure } from "./errors.mjs";

const open = async (profilePath, options) =>
  (await import("../ntulearn/client.mjs")).openClient(profilePath, options);
const cleanupFailure = (cause) =>
  markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Owned discovery browser cleanup is unconfirmed; retain containment before any retry.",
        { cause },
      ),
      { code: "MEDIA_BROWSER_CLEANUP" },
    ),
  );
const identity = ({ key, courseId }) => ({ key, courseId });

export async function runMediaDiscovery({ config, key, signal }, dependencies = {}) {
  const report = {
    schemaVersion: 1,
    command: "media:discover",
    courses: [],
    refused: [],
    notAttempted: [],
    globalStop: false,
    cleanup: "not-opened",
    safetyBarrier: "unrun",
  };
  let selected = [],
    attempted = 0,
    current;
  try {
    selected = selectCourses(config.courses, key);
    await (dependencies.lock ?? withMediaQueueLock)({
      statePath: config.statePath,
      run: async () => {
        try {
          signal?.throwIfAborted();
          await (dependencies.admission ?? assertMediaSafetyAdmission)({
            statePath: config.statePath,
            courses: config.courses,
            readQueue: readMediaQueue,
          });
          for (const course of selected) {
            signal?.throwIfAborted();
            current = course;
            attempted++;
            let discovery;
            try {
              discovery = await readOwnedCourse({ config, course, signal, report }, dependencies);
            } catch (error) {
              if (!(error instanceof CourseRefused)) throw error;
              report.refused.push({
                ...identity(course),
                code: "MEDIA_DISCOVERY_COURSE_REFUSED",
                action: "Inspect this course's access; a closed course does not require login.",
              });
              current = undefined;
              continue;
            }
            signal?.throwIfAborted();
            if (!discovery.skipped) {
              const saved = await (dependencies.writeQueue ?? writeMediaQueue)({
                statePath: config.statePath,
                course,
                discovery,
              });
              discovery.queuePath = saved.path;
            } else {
              const status = await (dependencies.writeStatus ?? writeMediaCourseStatus)({
                course,
                discovery,
              });
              if (status) discovery.statusPath = status.path;
            }
            report.courses.push({ ...discovery, ...identity(course) });
            current = undefined;
          }
          signal?.throwIfAborted();
        } catch (error) {
          if (error?.code === "NTULEARN_BROWSER_CLEANUP" || error?.code === "MEDIA_BROWSER_CLEANUP")
            await retainCleanupBarrier(config, report, error, dependencies);
          throw error;
        }
      },
    });
    report.status =
      report.refused.length || report.courses.some((course) => course.complete === false)
        ? "failed"
        : "passed";
    report.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    const cleanup =
      report.cleanup === "unconfirmed" ||
      error?.code === "NTULEARN_BROWSER_CLEANUP" ||
      error?.code === "MEDIA_BROWSER_CLEANUP";
    const failure = cleanup ? cleanupFailure(error) : error;
    let failureCode = cleanup
      ? "MEDIA_BROWSER_CLEANUP"
      : signal?.aborted
        ? "MEDIA_INTERRUPTED"
        : ["MEDIA_QUEUE_LOCK_HELD", "MEDIA_SAFETY_BARRIER"].includes(error?.code)
          ? error.code
          : "MEDIA_DISCOVERY_FAILED";
    if (cleanup && report.safetyBarrier === "unrun")
      await retainCleanupBarrier(config, report, failure, dependencies);
    if (report.safetyBarrier === "write-failed") failureCode = "MEDIA_SAFETY_BARRIER_WRITE";
    report.status = "failed";
    report.exitCode = 1;
    report.failureCode = failureCode;
    report.globalStop = cleanup || isGlobalMediaSafetyFailure(failure);
    report.action =
      cleanup || failureCode === "MEDIA_SAFETY_BARRIER"
        ? "Owner: retain external containment; verify owned browser/process cessation and inspect durable safety evidence before explicitly clearing barriers. Do not retry automatically."
        : failureCode === "MEDIA_QUEUE_LOCK_HELD"
          ? "Wait for the active run to finish, then retry explicit media discovery."
          : failureCode === "MEDIA_INTERRUPTED"
            ? "Inspect retained per-course results; rerun explicit media discovery after owned closure."
            : "Inspect configured course access, profile paths/storage and saved-session diagnostics; run npm run login if sign-in requires recovery, then retry explicit media discovery.";
    if (current)
      report.courses.push({ ...identity(current), complete: false, verdict: "red", failureCode });
    report.notAttempted = selected.slice(attempted).map(identity);
  }
  return report;
}

async function readOwnedCourse({ config, course, signal, report }, dependencies) {
  if (!isMediaCourseEnabled(course))
    return (dependencies.discover ?? discoverCourseMedia)({ client: null, course });
  const timeoutMs = dependencies.closeTimeoutMs ?? 30000;
  let client, discovery, failure, abort, closure, reading;
  const close = () => (closure ??= closeOwnedClient(client, timeoutMs));
  try {
    client = await (dependencies.open ?? open)(config.profilePath, {
      signalOwner: "caller",
      startupCleanupTimeoutMs: timeoutMs,
    });
    report.cleanup = "pending";
    signal?.throwIfAborted();
    const interrupted = new Promise((resolve) => {
      abort = () => {
        close().catch(() => {});
        resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    reading = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return (dependencies.discover ?? discoverCourseMedia)({ client, course });
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    if (signal?.aborted) abort();
    await Promise.race([reading, interrupted]);
  } catch (error) {
    failure = error;
  }
  try {
    if (client) {
      await close();
      if (reading) {
        const settled = await boundedReadSettlement(reading, timeoutMs);
        discovery = settled.value;
        failure ??= settled.error;
      }
      report.cleanup = "confirmed";
    }
  } catch (cause) {
    throw cleanupFailure(cause);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
  if (failure?.code === "NTULEARN_BROWSER_CLEANUP" || isGlobalMediaSafetyFailure(failure))
    throw failure;
  signal?.throwIfAborted();
  if (failure) throw failure;
  return discovery;
}

async function boundedReadSettlement(reading, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(cleanupFailure()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeOwnedClient(client, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
    throw cleanupFailure();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => client.close()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(cleanupFailure()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function retainCleanupBarrier(config, report, error, dependencies) {
  report.cleanup = "unconfirmed";
  report.cleanupCode = "MEDIA_BROWSER_CLEANUP";
  try {
    await (dependencies.persistBarrier ?? persistMediaSafetyBarrier)({
      statePath: config.statePath,
      error: cleanupFailure(error),
    });
    report.safetyBarrier = "retained";
  } catch {
    report.safetyBarrier = "write-failed";
  }
}
