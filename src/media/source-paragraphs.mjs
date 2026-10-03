import { Buffer } from "node:buffer";
import {
  historicalParagraphs,
  historicalTextFlags,
  HISTORICAL_FORMAT_VERSION,
} from "./historical-format.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";

export const SOURCE_PARAGRAPH_LIMITS = Object.freeze({
  maxSegments: 100000,
  maxSourceBytes: 16 * 1024 ** 2,
});
export const SOURCE_REVIEW_FLAGS = Object.freeze([
  "empty",
  "encoding-or-control",
  "html-payload",
  "login-or-error-payload",
  "prompt-or-runtime-banner",
  "suspicious-repetition",
  "invalid-source-structure",
  "source-budget",
  "native-safety-rejected",
]);
export const SOURCE_REVIEW_ACTION =
  "Transcript source needs Owner review; retained source and media are unchanged. Inspect source-quality evidence; use explicit source-preserving recovery when appropriate. No automatic correction or retry.";

export function validateSourceReviewFlags(flags, { required = false } = {}) {
  if (
    !Array.isArray(flags) ||
    (required && !flags.length) ||
    flags.length > SOURCE_REVIEW_FLAGS.length ||
    flags.some((flag) => !SOURCE_REVIEW_FLAGS.includes(flag))
  )
    throw new Error(
      "Transcript source review evidence is malformed; inspect retained evidence before retrying.",
    );
  return [...new Set(flags)];
}

export function sourceReviewFlags({ segments } = {}, signal) {
  signal?.throwIfAborted();
  if (!Array.isArray(segments)) return ["invalid-source-structure"];
  if (segments.length > SOURCE_PARAGRAPH_LIMITS.maxSegments) return ["source-budget"];
  let bytes = 0;
  for (const segment of segments) {
    signal?.throwIfAborted();
    if (
      typeof segment?.text !== "string" ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    )
      return ["invalid-source-structure"];
    bytes += Buffer.byteLength(segment.text) + 1;
    if (bytes > SOURCE_PARAGRAPH_LIMITS.maxSourceBytes) return ["source-budget"];
  }
  const flags = historicalTextFlags(segments.map(({ text }) => text).join("\n"));
  try {
    safeNativeTranscriptBody({ segments });
  } catch {
    flags.push("native-safety-rejected");
  }
  return [...new Set(flags)];
}

function nativeTextFlags(body, signal) {
  signal?.throwIfAborted();
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  // Structured source metadata is not transcript wording; inspect its parsed segments instead.
  if (
    typeof text !== "string" ||
    text.trimStart().startsWith("[") ||
    text.trimStart().startsWith("{")
  )
    return [];
  return historicalTextFlags(text);
}

export function createSourceParagraphFormatter() {
  return {
    version: HISTORICAL_FORMAT_VERSION,
    inspect: sourceReviewFlags,
    inspectNative: nativeTextFlags,
    async format({ segments, signal }) {
      const flags = sourceReviewFlags({ segments }, signal);
      if (flags.length)
        return { reviewRequired: true, flags, modelCalls: 0, limitations: [SOURCE_REVIEW_ACTION] };
      const markdown = historicalParagraphs({ segments });
      signal?.throwIfAborted();
      return { markdown, modelCalls: 0, reviewRequired: false };
    },
  };
}
