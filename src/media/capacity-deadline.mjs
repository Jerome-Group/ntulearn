import { setTimeout, clearTimeout } from "node:timers";
import { markGlobalMediaSafety } from "./errors.mjs";

export function withCapacityDeadline(probe, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw markGlobalMediaSafety(
      new Error("Capacity checks need a positive deadline. Retry with a valid capacity timeout."),
    );
  }
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        "Media capacity check timed out. Restore responsive mounted storage, then retry the media worker.",
      );
      error.code = "MEDIA_CAPACITY_TIMEOUT";
      reject(markGlobalMediaSafety(error));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve()
      .then(probe)
      .catch((error) => {
        throw markGlobalMediaSafety(error);
      }),
    deadline,
  ]).finally(() => clearTimeout(timer));
}
