import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { FORMATTER_PROMPT_OPENING } from "./formatter-contract.mjs";

const TIMESTAMP = /^(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?$/;
const TIMESTAMP_RANGE =
  /^(\d{1,2}(?::\d{2}){1,2}[.,]?\d{0,3})\s+-->\s+(\d{1,2}(?::\d{2}){1,2}[.,]?\d{0,3})/;
const FORMATTED_TIMESTAMP = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const FORMATTER_PROMPT = new RegExp(escapeRegExp(FORMATTER_PROMPT_OPENING), "gi");
const PROTECTED_TOKEN = /\d+(?:\.\d+)?|[+\-−×÷*/=<>≤≥^]/g;
const SOURCE_KINDS = new Set(["provider", "generated", "non-speech"]);
// eslint-disable-next-line no-control-regex -- ASCII is the deliberate language boundary
const NON_ASCII_RUN = /[^\x00-\x7F]+/g;

export function parseProviderTranscript(value) {
  const body = value?.body ?? value?.content ?? value;
  const parsed = parseBody(body);
  const segments = segmentValues(parsed);
  if (!segments) throw new Error("provider transcript has no supported segments");
  return {
    sourceKind: "provider",
    language: value?.language ?? value?.lang ?? parsed.language ?? parsed.lang ?? "und",
    segments,
  };
}

export function validateTranscript(
  transcript,
  { duration, speechDuration, coverageRatio = 0.5, allowMissingDuration = false } = {},
) {
  let normalized;
  try {
    normalized = normalizeTranscript(transcript);
  } catch (error) {
    return { valid: false, reason: error.message };
  }

  if (normalized.sourceKind === "non-speech") {
    if (normalized.segments.length) {
      return { valid: false, reason: "non-speech source contains speech segments" };
    }
    return { valid: true, transcript: normalized };
  }
  if (!normalized.segments.length) return { valid: false, reason: "it contains no segments" };
  if (!normalized.segments.some(({ text }) => /[\p{L}\p{N}]/u.test(text))) {
    return { valid: false, reason: "it contains no meaningful speech text" };
  }

  let previous = null;
  for (const segment of normalized.segments) {
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    ) {
      return { valid: false, reason: "it contains invalid segment timestamps" };
    }
    if (previous && (segment.start < previous.start || segment.end < previous.end)) {
      return { valid: false, reason: "its segment timestamps are not ordered" };
    }
    previous = segment;
  }

  const expectedDuration = numberOrNull(speechDuration ?? duration);
  if (expectedDuration === null || expectedDuration <= 0) {
    if (allowMissingDuration) return { valid: true, transcript: normalized };
    return { valid: false, reason: "recording duration is unavailable for coverage validation" };
  }
  const lastEnd = normalized.segments.at(-1).end;
  const recordingDuration = numberOrNull(duration) ?? expectedDuration;
  const tolerance = Math.max(2, recordingDuration * 0.05);
  if (lastEnd > recordingDuration + tolerance) {
    return { valid: false, reason: "it extends beyond recording duration" };
  }
  if (lastEnd < expectedDuration * coverageRatio) {
    return {
      valid: false,
      reason: `it covers ${lastEnd.toFixed(1)}s of ${expectedDuration.toFixed(1)}s`,
    };
  }

  return { valid: true, transcript: normalized };
}

export function normalizeTranscript(transcript) {
  const sourceKind = String(transcript?.sourceKind ?? "provider").trim() || "provider";
  if (!SOURCE_KINDS.has(sourceKind))
    throw new Error(`unsupported transcript source kind: ${sourceKind}`);
  const language = String(transcript?.language ?? "und").trim() || "und";
  const segments = (transcript?.segments ?? []).map((segment) => {
    const start = numberOrNull(segment.start);
    const end = numberOrNull(segment.end);
    const text = String(segment.text ?? "").trim();
    if (start === null || end === null || !text) {
      throw new Error("it contains a segment without numeric timestamps and text");
    }
    return { start, end, text };
  });
  const normalized = { sourceKind, language, segments };
  if (sourceKind === "non-speech") {
    const reason = String(transcript?.reason ?? "").trim();
    if (!reason) throw new Error("non-speech source needs a reason");
    normalized.reason = reason;
  }
  return normalized;
}

export function rawTranscriptJson(transcript) {
  return `${JSON.stringify(normalizeTranscript(transcript), null, 2)}\n`;
}

export function transcriptDigest(rawJson) {
  return createHash("sha256").update(rawJson).digest("hex");
}

export function assertFormattedTranscript(markdown, segments) {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("formatted transcript is empty");
  }
  if (FORMATTED_TIMESTAMP.test(markdown)) {
    throw new Error("formatted transcript still contains timestamps");
  }
  const sourceText = segments.map(({ text }) => text).join(" ");
  if (promptOccurrences(markdown) > promptOccurrences(sourceText)) {
    throw new Error("formatted transcript contains formatter prompt");
  }

  const expectedTokens = protectedTokens(sourceText);
  const actualTokens = protectedTokens(markdown);
  const expected = tokenCounts(expectedTokens);
  const actual = tokenCounts(actualTokens);
  for (const [token, count] of expected) {
    if ((actual.get(token) ?? 0) < count) {
      throw new Error(`formatted transcript loses protected notation: ${token}`);
    }
  }
  if (!isSubsequence(expectedTokens, actualTokens)) {
    throw new Error("formatted transcript reorders protected notation");
  }
  for (const run of segments
    .map(({ text }) => text.match(NON_ASCII_RUN) ?? [])
    .flat()
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!markdown.includes(run))
      throw new Error(`formatted transcript loses code-switched text: ${run}`);
  }
  const switchedWords = segments
    .map(({ text }) => text)
    // eslint-disable-next-line no-control-regex -- ASCII is the deliberate language boundary
    .filter((text) => /[^\x00-\x7F]/.test(text) && /[A-Za-z]/.test(text))
    .flatMap((text) => lexicalWords(text));
  if (!isSubsequence(switchedWords, lexicalWords(markdown))) {
    throw new Error("formatted transcript loses code-switched text");
  }
  return markdown.trimEnd() + "\n";
}

function promptOccurrences(value) {
  return String(value ?? "").match(FORMATTER_PROMPT)?.length ?? 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBody(body) {
  if (Buffer.isBuffer(body)) return parseBody(body.toString("utf8"));
  if (body && typeof body === "object") return body;
  if (typeof body !== "string" || !body.trim()) throw new Error("provider transcript is empty");

  try {
    return JSON.parse(body);
  } catch {
    return parseCaptionText(body);
  }
}

function segmentValues(parsed) {
  const values = parsed.segments ?? parsed.captions ?? parsed.events;
  if (!Array.isArray(values)) return null;
  return values.map((segment) => ({
    start: parseTime(segment.start ?? segment.startTime ?? segment.start_time),
    end: parseTime(segment.end ?? segment.endTime ?? segment.end_time),
    text: textOf(segment.text ?? segment.caption ?? segment.content),
  }));
}

function parseCaptionText(value) {
  const segments = [];
  let current = null;
  for (const line of value.replace(/^WEBVTT\s*\n?/i, "").split(/\r?\n/)) {
    const range = line.match(TIMESTAMP_RANGE);
    if (range) {
      if (current) segments.push(current);
      current = { start: parseTime(range[1]), end: parseTime(range[2]), text: "" };
    } else if (current && line.trim()) {
      current.text = `${current.text} ${line.trim()}`.trim();
    } else if (!line.trim() && current) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return { segments };
}

function parseTime(value) {
  if (typeof value === "number") return value > 100_000 ? value / 1000 : value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const text = value.trim().replace(",", ".");
  if (!TIMESTAMP.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  const seconds = parts.pop();
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  return String(value ?? "");
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function protectedTokens(value) {
  return [...value.matchAll(PROTECTED_TOKEN)].map(([token]) => token);
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function lexicalWords(value) {
  return [...value.matchAll(/[A-Za-z][A-Za-z0-9'-]*/g)].map(([word]) => word);
}

function isSubsequence(expected, actual) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index += 1;
    if (index === expected.length) return true;
  }
  return index === expected.length;
}
