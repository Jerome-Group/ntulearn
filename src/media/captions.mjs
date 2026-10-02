import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

const CAPTION_LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const PUBLIC_FAILURES = new Set([
  "Caption fetch interrupted.",
  "Caption fetch timed out. Retry provider resolution.",
  "Caption fetch failed. Retry provider resolution.",
  "Caption body exceeds the byte limit.",
  "Caption fetch returned no readable body.",
]);

export function youtubeCaptions(metadata) {
  for (const [kind, tracks] of [
    ["manual", metadata.subtitles],
    ["automatic", metadata.automatic_captions],
  ]) {
    const candidates = Object.entries(tracks ?? {}).flatMap(([language, representations]) => {
      if (!CAPTION_LANGUAGE.test(language) || !Array.isArray(representations)) return [];
      return representations
        .filter((track) => track?.ext === "vtt" && validCaptionAddress(track.url))
        .map((track) => ({
          url: track.url,
          language,
          filename: "captions.vtt",
          captionProvenance: { kind, language, format: "vtt" },
        }));
    });
    candidates.sort(
      (a, b) =>
        Number(b.language === metadata.language) - Number(a.language === metadata.language) ||
        compare(a.language, b.language) ||
        compare(a.url, b.url),
    );
    if (candidates.length) return [candidates[0]];
  }
  return [];
}

export function createCaptionFetcher({
  fetch: request = globalThis.fetch,
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 30_000,
} = {}) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Caption fetch needs positive byte and timeout limits.");
  return async (address, { signal } = {}) => {
    if (!validCaptionAddress(address)) throw new Error("Caption address is unsupported.");
    if (signal?.aborted) throw new Error("Caption fetch interrupted.");
    const controller = new globalThis.AbortController();
    let interrupt;
    const interrupted = new Promise((_resolve, reject) => {
      interrupt = reject;
    });
    const stop = (message) => {
      controller.abort();
      interrupt(new Error(message));
    };
    const abort = () => stop("Caption fetch interrupted.");
    const timer = setTimeout(
      () => stop("Caption fetch timed out. Retry provider resolution."),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let reader;
    try {
      const response = await Promise.race([
        request(address, { signal: controller.signal }),
        interrupted,
      ]);
      if (!response.ok) throw new Error("Caption fetch failed. Retry provider resolution.");
      if (Number(response.headers.get("content-length")) > maxBytes)
        throw new Error("Caption body exceeds the byte limit.");
      if (!response.body?.getReader) throw new Error("Caption fetch returned no readable body.");
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), interrupted]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Caption body exceeds the byte limit.");
        chunks.push(Buffer.from(chunk.value));
      }
      return { body: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      // Transport errors can include signed addresses; only our own bounded failures are public.
      if (PUBLIC_FAILURES.has(error?.message)) throw new Error(error.message, { cause: error });
      throw new Error("Caption fetch failed. Retry provider resolution.", { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  };
}

function validCaptionAddress(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
