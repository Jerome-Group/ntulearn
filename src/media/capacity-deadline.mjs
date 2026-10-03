import { markGlobalMediaSafety } from "./errors.mjs";
import { withMediaProbeSettlement } from "./probe-settlement.mjs";

export function withCapacityDeadline(probe, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw markGlobalMediaSafety(
      new Error("Capacity checks need a positive deadline. Retry with a valid capacity timeout."),
    );
  }
  const error = new Error(
    "Media capacity check timed out. Restore responsive mounted storage, then retry the media worker.",
  );
  error.code = "MEDIA_CAPACITY_TIMEOUT";
  return withMediaProbeSettlement(probe, {
    timeoutMs,
    timeoutError: markGlobalMediaSafety(error),
  }).catch((cause) => {
    throw markGlobalMediaSafety(cause);
  });
}
