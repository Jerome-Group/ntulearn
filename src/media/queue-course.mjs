import { performance } from "node:perf_hooks";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";

const MAX_DESTINATIONS = 256;
const RESOLUTION_DEADLINE_MS = 5000;
const BOUNDARY_ACTION =
  "Existing artifacts are retained; review the course configuration and restore accessible course folders before retrying media discovery.";

export function queueCourseBoundary({
  course = null,
  resolvePath = realpath,
  inspect = stat,
  timeoutMs = RESOLUTION_DEADLINE_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > RESOLUTION_DEADLINE_MS) {
    throw new Error(
      `Media queue destination checks need a deadline of at most five seconds. ${BOUNDARY_ACTION}`,
    );
  }
  const canonical = new Map();
  const pending = new Map();
  let deadline;

  async function physical(destination) {
    if (pending.has(destination)) return pending.get(destination);
    if (pending.size >= MAX_DESTINATIONS)
      throw new Error(
        `Media queue has too many distinct destinations to verify. ${BOUNDARY_ACTION}`,
      );
    deadline ??= performance.now() + timeoutMs;
    const result = bounded(async () => {
      const path = await resolvePath(destination);
      const info = await inspect(path);
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        !info.isDirectory() ||
        (await resolvePath(destination)) !== path
      ) {
        throw new Error("Physical directory identity is unavailable or changed.");
      }
      return path;
    }).then((path) => {
      canonical.set(destination, path);
      return path;
    });
    pending.set(destination, result);
    return result;
  }

  async function bounded(probe) {
    const remaining = Math.ceil(deadline - performance.now());
    let timer;
    try {
      if (remaining <= 0) throw new Error("Physical directory resolution deadline elapsed.");
      return await Promise.race([
        Promise.resolve().then(probe),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Physical directory resolution deadline elapsed.")),
            remaining,
          );
        }),
      ]);
    } catch (cause) {
      const error = new Error(
        `Media queue destination cannot be positively verified. ${BOUNDARY_ACTION}`,
        { cause },
      );
      error.code = cause.code ?? "MEDIA_QUEUE_DESTINATION_UNVERIFIED";
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async assert(queue, courseId) {
      if (queue == null) return;
      if (!Array.isArray(queue))
        throw new Error(`Media queue appearances must be an array. ${BOUNDARY_ACTION}`);
      for (const job of queue) {
        if (
          !job ||
          typeof job !== "object" ||
          Array.isArray(job) ||
          (job.courseId && job.courseId !== courseId) ||
          (course?.key &&
            job.courseKey &&
            String(job.courseKey).toLowerCase() !== course.key.toLowerCase())
        ) {
          throw new Error(
            `Media queue appearance belongs to another course or is malformed. ${BOUNDARY_ACTION}`,
          );
        }
        if (job.placement == null) continue;
        const destination = job.placement.destination;
        if (
          typeof job.placement !== "object" ||
          Array.isArray(job.placement) ||
          typeof destination !== "string" ||
          !isAbsolute(destination) ||
          destination.includes("\0")
        ) {
          throw new Error(
            `Media queue placement needs an absolute course destination. ${BOUNDARY_ACTION}`,
          );
        }
        if (!course?.destination || destination === course.destination) continue;
        const expected = await physical(course.destination);
        if ((await physical(destination)) !== expected) {
          throw new Error(
            `Media queue appearance belongs to another physical destination. ${BOUNDARY_ACTION}`,
          );
        }
      }
    },
    placementKey(destination) {
      return canonical.get(destination) ?? destination;
    },
  };
}
