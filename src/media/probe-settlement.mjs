import { setTimeout, clearTimeout } from "node:timers";
import { markGlobalMediaSafety, unconfirmedMediaCleanupCode } from "./errors.mjs";

const SETTLEMENT_MS = 5000;

function mediaProbeCleanupFailure(cause) {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Owned media probe I/O or descriptor cleanup is unconfirmed. Retain admission containment and inspect before retrying.",
        { cause },
      ),
      { code: "MEDIA_FILE_CLEANUP" },
    ),
  );
}

export async function closeMediaProbeHandle(handle) {
  try {
    await handle.close();
  } catch (cause) {
    throw mediaProbeCleanupFailure(cause);
  }
}

export async function withMediaProbeSettlement(operation, { timeoutMs, timeoutError }) {
  let timer,
    settlementTimer,
    expired = false;
  const active = () => {
    if (expired) throw timeoutError;
  };
  const pending = Promise.resolve()
    .then(() => operation(active))
    .then(
      (value) => ({ value }),
      (error) => ({ error, failed: true }),
    );
  try {
    let outcome;
    try {
      outcome = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (!expired) throw error;
      const settled = await Promise.race([
        pending,
        new Promise((_, reject) => {
          settlementTimer = setTimeout(
            () => reject(mediaProbeCleanupFailure(error)),
            Math.min(timeoutMs, SETTLEMENT_MS),
          );
        }),
      ]);
      if (unconfirmedMediaCleanupCode(settled.error)) throw settled.error;
      throw error;
    }
    if (outcome.failed) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(timer);
    clearTimeout(settlementTimer);
  }
}
