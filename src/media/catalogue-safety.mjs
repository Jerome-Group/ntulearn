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

export function parseCatalogueMetadata(
  content,
  {
    limits = CATALOGUE_METADATA_LIMITS,
    forbiddenKeys = [],
    allowForbiddenStringKey = () => false,
  } = {},
) {
  if (!Buffer.isBuffer(content)) throw failure("CATALOGUE_METADATA_INVALID");
  if (content.length > limits.bytes) throw failure("CATALOGUE_METADATA_LIMIT");
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
    if (Buffer.byteLength(string) > limits.stringBytes) throw failure("CATALOGUE_METADATA_LIMIT");
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
  const containers = [];
  let tokens = 0,
    rawDepth = 0,
    rawValues = 0;
  for (const match of text.matchAll(
    /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/gs,
  )) {
    if (++tokens > limits.values * 6) throw failure("CATALOGUE_METADATA_LIMIT");
    const token = match[0],
      key = token[0] === '"' && /^\s*:/.test(text.slice(match.index + token.length));
    if (token[0] === '"') {
      const string = JSON.parse(token);
      if (key && forbiddenKeys.some((field) => field.toLowerCase() === string.toLowerCase())) {
        const scalar = /^\s*:\s*("(?:[^"\\]|\\.)*")/s.exec(text.slice(match.index + token.length));
        if (
          !scalar ||
          !allowForbiddenStringKey({
            path: [...(containers.at(-1)?.path ?? []), string],
            value: JSON.parse(scalar[1]),
          })
        )
          throw failure("CATALOGUE_METADATA_UNSAFE");
      }
      if (key) containers.at(-1).key = string;
      checkString(string);
    } else if (/^-?\d/.test(token) && !Number.isFinite(Number(token)))
      throw failure("CATALOGUE_METADATA_INVALID");
    if (token === "]" || token === "}") {
      rawDepth--;
      containers.pop();
    } else if (!key && token !== "," && token !== ":") {
      const parent = containers.at(-1);
      const path = parent ? [...parent.path, parent.array ? parent.index++ : parent.key] : [];
      if (parent) parent.key = null;
      if (token === "[" || token === "{")
        containers.push({ path, array: token === "[", index: 0, key: null });
      if (++rawValues > limits.values || rawDepth > limits.depth)
        throw failure("CATALOGUE_METADATA_LIMIT");
      if (token === "[" || token === "{") rawDepth++;
    }
  }
  while (stack.length) {
    const next = stack.pop();
    if (++count > limits.values || next.depth > limits.depth)
      throw failure("CATALOGUE_METADATA_LIMIT");
    if (typeof next.value === "number" && !Number.isFinite(next.value))
      throw failure("CATALOGUE_METADATA_INVALID");
    else if (next.value && typeof next.value === "object") {
      for (const key of Object.keys(next.value)) {
        if (stack.length + count >= limits.values) throw failure("CATALOGUE_METADATA_LIMIT");
        stack.push({ value: next.value[key], depth: next.depth + 1 });
      }
    }
  }
  return value;
}
