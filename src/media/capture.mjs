import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { publicMediaError } from "./errors.mjs";

export const DEFAULT_PROBE_DURATION_MS = 3_000;
export const DEFAULT_CAPTURE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const CLEANUP_STOP_TIMEOUT_MS = 5_000;

export function createPlaybackCapture({
  playback,
  audioRouting,
  probeDurationMs = DEFAULT_PROBE_DURATION_MS,
  timeoutMs = null,
  requestedRate = 1,
  ownerEvidence = null,
}) {
  assertAdapter(playback, ["open", "probe", "capture", "stop"], "playback");
  assertAdapter(audioRouting, ["prepare", "restore"], "audio routing");
  if (!Number.isSafeInteger(probeDurationMs) || probeDurationMs <= 0) {
    throw new Error("Playback capture needs a positive audio-probe duration.");
  }
  assertTimeout(timeoutMs);

  // The adapter contract is deliberately controls-only: it has no request, manifest, token, or
  // key channel, so a playback implementation cannot turn this fallback into access bypass.
  return {
    name: "browser-playback",

    media({ appearance, resolved = null, signal }) {
      return capturePlayback({
        appearance,
        resolved,
        playback,
        audioRouting,
        probeDurationMs,
        timeoutMs,
        requestedRate,
        ownerEvidence,
        signal,
      });
    },
  };
}

async function capturePlayback({
  appearance,
  resolved = null,
  playback,
  audioRouting,
  probeDurationMs = DEFAULT_PROBE_DURATION_MS,
  timeoutMs = null,
  requestedRate = 1,
  ownerEvidence = null,
  signal,
}) {
  const rate = resolvePlaybackRate({
    provider: appearance?.provider,
    requestedRate,
    ownerEvidence,
  });
  const control = createCaptureControl(signal, timeoutFor(resolved, timeoutMs));
  const captureSignal = control.signal;
  let session = null;
  let routing = null;
  let result = null;
  let operationError = null;

  try {
    throwIfAborted(captureSignal);
    routing = await awaitWithAbort(
      audioRouting.prepare({ appearance, resolved, signal: captureSignal }),
      captureSignal,
    );
    throwIfAborted(captureSignal);
    session = await awaitWithAbort(
      playback.open({
        appearance,
        resolved,
        rate,
        studentVisibleOnly: true,
        signal: captureSignal,
      }),
      captureSignal,
    );
    throwIfAborted(captureSignal);
    const probe = await awaitWithAbort(
      playback.probe(session, {
        appearance,
        resolved,
        durationMs: probeDurationMs,
        rate,
        signal: captureSignal,
      }),
      captureSignal,
    );
    if (!meaningfulProbe(probe)) {
      result = {
        kind: "unavailable",
        limitation:
          "Browser playback audio probe was silent or unintelligible; capture aborted. Retry after checking playback and audio routing.",
        retryable: true,
      };
    } else {
      throwIfAborted(captureSignal);
      const captured = await awaitWithAbort(
        playback.capture(session, {
          appearance,
          resolved,
          rate,
          studentVisibleOnly: true,
          signal: captureSignal,
        }),
        captureSignal,
      );
      throwIfAborted(captureSignal);
      result = normalizeCapture(captured, { rate, ownerEvidence });
    }
  } catch (error) {
    operationError = new Error(
      `Browser playback capture failed: ${withRetryAction(publicMediaError(error))}`,
      { cause: error },
    );
  }

  let cleanupError;
  try {
    cleanupError = await cleanup({ playback, session, audioRouting, routing });
  } finally {
    control.dispose();
  }
  if (operationError && cleanupError) {
    throw new Error(`${operationError.message}; ${cleanupError.message}`, {
      cause: operationError,
    });
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function resolvePlaybackRate({ provider, requestedRate = 1, ownerEvidence = null }) {
  if (Number(requestedRate) !== 2) return 1;
  if (
    ownerEvidence?.recordedBy !== "Owner" ||
    !nonEmpty(ownerEvidence.evidenceId) ||
    !recordedAt(ownerEvidence.recordedAt) ||
    ownerEvidence.provider !== provider ||
    ownerEvidence.durationCoverage !== true ||
    ownerEvidence.timestampAlignment !== true ||
    ownerEvidence.intelligibility !== true
  ) {
    return 1;
  }
  return 2;
}

function meaningfulProbe(probe) {
  return probe?.meaningful === true || (probe?.audible === true && probe?.intelligible === true);
}

function normalizeCapture(value, { rate, ownerEvidence }) {
  const body = value?.body ?? value?.content;
  if (!value || (value.kind !== "video" && value.kind !== "audio")) {
    throw new Error("Browser playback capture returned no video or audio.");
  }
  if (!Buffer.isBuffer(body) && !ArrayBuffer.isView(body)) {
    throw new Error("Browser playback capture returned no media bytes.");
  }

  const kind = value.kind;
  const fallbackLimitation =
    kind === "audio"
      ? "Browser playback capture retained audio-only media; video capture was unavailable."
      : "Media retained from signed-in browser playback capture.";
  const limitations = [fallbackLimitation, value.limitation];
  if (rate === 2) {
    limitations.push(`Playback ran at 2x under Owner evidence ${ownerEvidence.evidenceId}.`);
  }
  const result = {
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    filename: value.filename ?? (kind === "audio" ? "capture.m4a" : "capture.mp4"),
    audio: kind === "audio" || value.audio !== false,
    kind,
    limitation: limitations
      .filter(Boolean)
      .map((limitation) => publicMediaError(limitation))
      .join(" "),
  };
  if (value.retryable === true) result.retryable = true;
  return result;
}

async function cleanup({ playback, session, audioRouting, routing }) {
  const stop = Promise.resolve().then(() => playback.stop(session, { reason: "capture-finished" }));
  const restore = Promise.resolve().then(() =>
    audioRouting.restore(routing, { reason: "capture-finished" }),
  );
  const [stopResult, restoreResult] = await Promise.all([
    settleWithin(
      stop,
      CLEANUP_STOP_TIMEOUT_MS,
      "Playback stop timed out; retry after checking the player.",
    ),
    settle(restore),
  ]);
  const errors = [];
  if (stopResult.status === "rejected") {
    errors.push(`playback stop failed: ${withRetryAction(publicMediaError(stopResult.reason))}`);
  }
  if (restoreResult.status === "rejected") {
    errors.push(
      `audio routing restore failed: ${withRetryAction(publicMediaError(restoreResult.reason))}`,
    );
  }
  return errors.length ? new Error(`Playback cleanup failed: ${errors.join("; ")}`) : null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason?.message && /timed out/i.test(reason.message)) throw reason;
  throw new Error("Browser playback capture interrupted; retry after the checkpoint.");
}

function createCaptureControl(inputSignal, timeoutMs) {
  const controller = new globalThis.AbortController();
  let timer = null;
  const forwardAbort = () => controller.abort(inputSignal.reason);
  if (inputSignal?.aborted) forwardAbort();
  else if (typeof inputSignal?.addEventListener === "function") {
    inputSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  if (timeoutMs !== null) {
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            "Browser playback capture timed out; retry after checking playback and audio routing.",
          ),
        ),
      timeoutMs,
    );
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      inputSignal?.removeEventListener?.("abort", forwardAbort);
    },
  };
}

function awaitWithAbort(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(reject, error);
      }
    };
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function settleWithin(promise, timeoutMs, timeoutMessage) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "rejected", reason: new Error(timeoutMessage) }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([settle(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutFor(resolved, timeoutMs) {
  if (timeoutMs !== null) return timeoutMs;
  const duration = Number(resolved?.duration);
  return Number.isFinite(duration) && duration > 0
    ? Math.ceil((duration + 5 * 60) * 1_000)
    : DEFAULT_CAPTURE_TIMEOUT_MS;
}

function assertTimeout(timeoutMs) {
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("Playback capture timeout must be a positive safe integer.");
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim();
}

function recordedAt(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function withRetryAction(message) {
  if (/retry after/i.test(message)) return message;
  return `${message.replace(/[.!?]+$/, "")}. Retry after checking playback and audio routing.`;
}

function assertAdapter(adapter, methods, label) {
  if (!adapter || methods.some((method) => typeof adapter[method] !== "function")) {
    throw new Error(`${label} adapter needs ${methods.join(", ")}.`);
  }
}
