import { setTimeout, clearTimeout } from "node:timers";

export async function withEvaluationRead(probe, { timeoutMs = 5000, signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000)
    throw new Error(
      "Evaluation reads need a deadline of at most five seconds. Retry with bounded inputs.",
    );
  const controller = new globalThis.AbortController();
  const combined = signal
    ? globalThis.AbortSignal.any([signal, controller.signal])
    : controller.signal;
  combined.throwIfAborted();
  let timer;
  let aborted;
  const stopped = new Promise((_resolve, reject) => {
    aborted = () => reject(combined.reason);
    combined.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => {
      const error = new Error(
        "Evaluation read timed out. Restore responsive private inputs/storage, then retry plan.",
      );
      error.code = "EVALUATION_READ_TIMEOUT";
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => probe(combined)), stopped]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", aborted);
  }
}
