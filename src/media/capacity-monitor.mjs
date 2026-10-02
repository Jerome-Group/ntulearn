import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { setTimeout, clearTimeout } from "node:timers";
import { markGlobalMediaSafety } from "./errors.mjs";

export function monitorMediaCapacity(
  check,
  {
    onFailure,
    intervalMs = 1_000,
    timeoutMs = 5_000,
    schedule = setTimeout,
    cancel = clearTimeout,
  },
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    throw new Error("Capacity monitoring needs a positive interval.");
  let stopped = false;
  let failed = false;
  let pending = null;
  let timer = null;
  const tick = () => {
    pending = withCapacityDeadline(check, { timeoutMs }).then(
      () => {
        if (!stopped) timer = schedule(tick, intervalMs);
      },
      (error) => {
        if (!failed) {
          failed = true;
          stopped = true;
          onFailure(markGlobalMediaSafety(error));
        }
      },
    );
  };
  timer = schedule(tick, intervalMs);
  return async () => {
    stopped = true;
    cancel(timer);
    await pending;
  };
}
