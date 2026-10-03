import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";

export const CATALOGUE_METADATA_LIMITS = Object.freeze({
  bytes: 16 * 1024 ** 2,
  values: 100000,
  depth: 16,
  stringBytes: 1024 ** 2,
});

const failure = (code) =>
  Object.assign(new Error("Inspect bounded private catalogue metadata."), { code });

export function parseCatalogueMetadata(content) {
  if (!Buffer.isBuffer(content)) throw failure("CATALOGUE_METADATA_INVALID");
  if (content.length > CATALOGUE_METADATA_LIMITS.bytes) throw failure("CATALOGUE_METADATA_LIMIT");
  let value, text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    value = JSON.parse(text);
  } catch {
    throw failure("CATALOGUE_METADATA_INVALID");
  }
  const stack = [{ value, depth: 0 }];
  let count = 0;
  const checkString = (string) => {
    if (Buffer.byteLength(string) > CATALOGUE_METADATA_LIMITS.stringBytes)
      throw failure("CATALOGUE_METADATA_LIMIT");
    try {
      // Each metadata value retains the existing address guard. A catalogue aggregates many files.
      // Wrapping preserves literal titles beginning with '[' or '{' instead of parsing them as JSON.
      safeNativeTranscriptBody({ checked: string });
    } catch {
      throw failure("CATALOGUE_METADATA_UNSAFE");
    }
  };
  // Inspect original tokens too: JSON.parse discards overwritten duplicate-key values.
  // Valid JSON has already been established; quoted strings consume their embedded digits.
  let tokens = 0,
    rawDepth = 0,
    rawValues = 0;
  for (const match of text.matchAll(
    /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/gs,
  )) {
    if (++tokens > CATALOGUE_METADATA_LIMITS.values * 6) throw failure("CATALOGUE_METADATA_LIMIT");
    const token = match[0],
      key = token[0] === '"' && /^\s*:/.test(text.slice(match.index + token.length));
    if (token[0] === '"') checkString(JSON.parse(token));
    else if (/^-?\d/.test(token) && !Number.isFinite(Number(token)))
      throw failure("CATALOGUE_METADATA_INVALID");
    if (token === "]" || token === "}") rawDepth--;
    else if (!key && token !== "," && token !== ":") {
      if (
        ++rawValues > CATALOGUE_METADATA_LIMITS.values ||
        rawDepth > CATALOGUE_METADATA_LIMITS.depth
      )
        throw failure("CATALOGUE_METADATA_LIMIT");
      if (token === "[" || token === "{") rawDepth++;
    }
  }
  while (stack.length) {
    const next = stack.pop();
    if (++count > CATALOGUE_METADATA_LIMITS.values || next.depth > CATALOGUE_METADATA_LIMITS.depth)
      throw failure("CATALOGUE_METADATA_LIMIT");
    if (typeof next.value === "number" && !Number.isFinite(next.value))
      throw failure("CATALOGUE_METADATA_INVALID");
    else if (next.value && typeof next.value === "object") {
      for (const key of Object.keys(next.value)) {
        if (stack.length + count >= CATALOGUE_METADATA_LIMITS.values)
          throw failure("CATALOGUE_METADATA_LIMIT");
        stack.push({ value: next.value[key], depth: next.depth + 1 });
      }
    }
  }
  return value;
}
