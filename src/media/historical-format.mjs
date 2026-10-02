import {
  assertFormattedTranscript,
  validateTranscript,
  parseProviderTranscript,
} from "./transcript.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";
import { TextDecoder } from "node:util";

export const HISTORICAL_FORMAT_VERSION = "source-paragraphs-v1";

export function historicalTextFlags(text) {
  const flags = [];
  if (!text.trim()) flags.push("empty");
  // eslint-disable-next-line no-control-regex -- rejected transcript controls
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/u.test(text)) flags.push("encoding-or-control");
  if (/<!doctype|<html\b|<body\b|<script\b/i.test(text)) flags.push("html-payload");
  if (
    /\b(?:sign in to your account|access denied|internal server error|unauthorized request)\b/i.test(
      text,
    )
  )
    flags.push("login-or-error-payload");
  if (
    /\b(?:return only the markdown transcript|preserve every source word|source language:|llama_model_loader|exiting\.\.\.)/i.test(
      text,
    )
  )
    flags.push("prompt-or-runtime-banner");
  const words = text.split(/\s+/u).filter(Boolean);
  let repeated = 0;
  for (let index = 1; index < words.length; index++) {
    repeated = words[index] === words[index - 1] ? repeated + 1 : 0;
    if (repeated >= 7) {
      flags.push("suspicious-repetition");
      break;
    }
  }
  // Four adjacent copies of a short phrase are review evidence, never a deletion rule.
  if (!flags.includes("suspicious-repetition")) {
    phrase: for (let index = 0; index < words.length; index++) {
      for (let width = 2; width <= 10 && index + width * 4 <= words.length; width++) {
        if (words[index] !== words[index + width]) continue;
        let equal = true;
        for (let offset = width; offset < width * 4; offset++) {
          if (words[index + offset] !== words[index + (offset % width)]) {
            equal = false;
            break;
          }
        }
        if (equal) {
          flags.push("suspicious-repetition");
          break phrase;
        }
      }
    }
  }
  const lines = text
    .split(/\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length >= 6 &&
    new Set(lines).size < lines.length / 3 &&
    !flags.includes("suspicious-repetition")
  )
    flags.push("suspicious-repetition");
  return flags;
}

export function inspectHistoricalSource(body, { native = false, duration, speechDuration } = {}) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { valid: false, flags: ["invalid-encoding"], timing: "unavailable" };
  }
  const flags = historicalTextFlags(text);
  try {
    safeNativeTranscriptBody(body);
  } catch {
    return { valid: false, flags: [...flags, "native-safety-rejected"], timing: "unavailable" };
  }
  let source;
  try {
    source = native ? parseProviderTranscript({ body: text }) : JSON.parse(text);
  } catch {
    return { valid: false, flags: [...flags, "malformed-source"], timing: "unavailable" };
  }
  const checked = validateTranscript(source, { allowMissingDuration: true, coverageRatio: 0 });
  if (!checked.valid)
    return { valid: false, flags: [...flags, "invalid-source-structure"], timing: "failed" };
  const sourceFlags = historicalTextFlags(
    checked.transcript.segments.map((segment) => segment.text).join("\n"),
  );
  const combined = [...new Set(sourceFlags)];
  const timing = Number.isFinite(speechDuration ?? duration)
    ? validateTranscript(source, { duration, speechDuration }).valid
      ? "passed"
      : "failed"
    : "unknown-duration";
  return {
    valid: true,
    source: checked.transcript,
    flags: combined,
    timing,
    eligible:
      checked.transcript.sourceKind !== "non-speech" &&
      !combined.some((flag) => flag !== "suspicious-repetition"),
  };
}

export function historicalParagraphs(source) {
  const paragraphs = [];
  let parts = [],
    length = 0;
  for (const segment of source.segments) {
    if (parts.length && (parts.length >= 8 || length + segment.text.length > 800)) {
      paragraphs.push(parts.join(" "));
      parts = [];
      length = 0;
    }
    parts.push(segment.text);
    length += segment.text.length + 1;
  }
  if (parts.length) paragraphs.push(parts.join(" "));
  return assertFormattedTranscript(paragraphs.join("\n\n"), source.segments);
}
