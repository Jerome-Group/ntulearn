import { isGlobalMediaSafetyFailure } from "./errors.mjs";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { abortableProviderWork, throwIfProviderAborted } from "./production-browser.mjs";

export const KALTURA_RESPONSE_LIMITS = Object.freeze({
  responses: 32,
  inFlight: 4,
  manifestBytes: 1024 * 1024,
  captionBytes: 4 * 1024 * 1024,
  retainedBytes: 16 * 1024 * 1024,
  drainMs: 5000,
});

const ACTION =
  "Kaltura response capture could not be verified. Retry signed-in playback; existing artifacts are retained.";
const CAPTION_UNAVAILABLE =
  "Kaltura provider captions were unavailable within response capture limits; local ASR may be used.";

export function captureKalturaResponses({ signal, limits = KALTURA_RESPONSE_LIMITS } = {}) {
  for (const key of Object.keys(KALTURA_RESPONSE_LIMITS)) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      limits[key] > KALTURA_RESPONSE_LIMITS[key]
    ) {
      throw new Error("Kaltura response capture needs positive conservative limits.");
    }
  }
  const manifests = [];
  const captions = [];
  const limitations = new Set();
  const pending = new Map();
  let count = 0;
  let bytes = 0;
  let accepting = true;
  let closed = false;
  let failure;

  function failed(error, kind) {
    if (closed || isGlobalMediaSafetyFailure(failure)) return;
    if (isGlobalMediaSafetyFailure(error)) failure = error;
    else if (signal?.aborted) failure = signal.reason ?? error;
    else if (kind === "caption") limitations.add(CAPTION_UNAVAILABLE);
    else failure ??= new Error(ACTION, { cause: error });
  }

  async function read(response, kind) {
    const maximum = kind === "manifest" ? limits.manifestBytes : limits.captionBytes;
    const headers = response.allHeaders ? await response.allHeaders() : await response.headers?.();
    const length = headers?.["content-length"];
    if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maximum)) {
      throw new Error("Kaltura announced response exceeds its capture bound.");
    }
    throwIfProviderAborted(signal);
    if (closed) return;
    const body = await response.text();
    if (closed) return;
    throwIfProviderAborted(signal);
    if (typeof body !== "string") throw new Error("Kaltura response text is unavailable.");
    const size = Buffer.byteLength(body, "utf8");
    if (size > maximum || bytes + size > limits.retainedBytes) {
      throw new Error("Kaltura received response exceeds its capture bound.");
    }
    if (kind === "caption" && !/^\s*WEBVTT/i.test(body)) {
      throw new Error("Kaltura caption response is not WebVTT.");
    }
    bytes += size;
    (kind === "manifest" ? manifests : captions).push(body);
  }

  function observe(response) {
    if (!accepting || closed) return;
    let kind;
    try {
      throwIfProviderAborted(signal);
      const url = response.url();
      kind = /playManifest/i.test(url)
        ? "manifest"
        : /(?:\.vtt|caption|subtitle)/i.test(url)
          ? "caption"
          : null;
      if (!kind) return;
      count++;
      if (count > limits.responses || pending.size >= limits.inFlight) {
        throw new Error("Kaltura response count or in-flight capture bound exceeded.");
      }
      const task = Promise.resolve()
        .then(() => read(response, kind))
        .catch((error) => failed(error, kind));
      pending.set(task, kind);
      void task.then(() => pending.delete(task));
    } catch (error) {
      failed(error, kind);
    }
  }

  function assert() {
    if (isGlobalMediaSafetyFailure(failure)) throw failure;
    throwIfProviderAborted(signal);
    if (failure) throw failure;
  }

  return {
    observe,
    assert,
    manifests,
    async finish() {
      accepting = false;
      let timer;
      try {
        await abortableProviderWork(
          Promise.race([
            Promise.all([...pending.keys()]),
            new Promise((resolve) => {
              timer = setTimeout(resolve, limits.drainMs);
            }),
          ]),
          signal,
        );
        for (const kind of pending.values())
          failed(new Error("Kaltura response drain deadline elapsed."), kind);
        assert();
        return {
          manifests: [...manifests],
          captions: [...captions],
          limitations: [...limitations],
          retainedBytes: bytes,
        };
      } catch (error) {
        if (isGlobalMediaSafetyFailure(failure)) throw failure;
        throw error;
      } finally {
        clearTimeout(timer);
        closed = true;
      }
    },
    dispose() {
      accepting = false;
      closed = true;
    },
  };
}
