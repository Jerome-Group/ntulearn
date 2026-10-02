import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_VALUES = 100000;
const MAX_DEPTH = 16;
const SENSITIVE =
  /^(?:ks|access_token|id_token|launch_token|launch|token|session|signature|cookie|state|sig)$/i;
const LITERAL =
  /\b(?:ks|access_token|id_token|launch_token|launch|token|session|signature|cookie|state|sig)\s*=/i;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function safeNativeTranscriptBody(value) {
  let body = value;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const key of ["body", "content"]) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && !("value" in property)) throw inspectionFailure();
      if (property?.value != null) {
        body = property.value;
        break;
      }
    }
  }
  if (!Buffer.isBuffer(body) && typeof body !== "string") {
    boundedStrings(body);
    try {
      body = Buffer.from(JSON.stringify(body));
    } catch {
      throw inspectionFailure();
    }
  }
  if (Buffer.byteLength(body) > MAX_BYTES) throw inspectionFailure();
  let text;
  try {
    text = Buffer.isBuffer(body) ? new TextDecoder("utf-8", { fatal: true }).decode(body) : body;
  } catch {
    throw inspectionFailure();
  }
  const representations = [text];
  const first = text.trimStart()[0];
  if (first === "[" || first === "{") {
    try {
      for (const string of boundedStrings(JSON.parse(text))) representations.push(string);
    } catch {
      throw inspectionFailure();
    }
  }
  let addresses = 0;
  for (const representation of representations) {
    const decoded = decodeEntities(representation);
    if (LITERAL.test(representation) || LITERAL.test(decoded)) throw sessionAddress();
    for (const match of decoded.matchAll(/(?:https?:\/\/|\/\/|\/|\?)[^\s<>"'\\]+/gi)) {
      if (++addresses > 4096 || match[0].length > 4096) throw inspectionFailure();
      let address;
      try {
        address = new URL(match[0], "https://native.invalid");
      } catch {
        throw inspectionFailure();
      }
      for (const key of address.searchParams.keys()) {
        if (SENSITIVE.test(key)) throw sessionAddress();
      }
      const parts = decodePath(address.pathname).split("/");
      if (parts.some((part, index) => /^ks$/i.test(part) && Boolean(parts[index + 1])))
        throw sessionAddress();
    }
  }
  return body;
}

function boundedStrings(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  const strings = [];
  let count = 0;
  let bytes = 0;
  while (stack.length) {
    const next = stack.pop();
    if (++count > MAX_VALUES || next.depth > MAX_DEPTH) throw inspectionFailure();
    if (typeof next.value === "string") {
      bytes += Buffer.byteLength(next.value);
      strings.push(next.value);
    } else if (next.value && typeof next.value === "object") {
      const prototype = Object.getPrototypeOf(next.value);
      if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype)
        throw inspectionFailure();
      assertNoSerializationHook(next.value);
      if (seen.has(next.value) || (Array.isArray(next.value) && next.value.length > MAX_VALUES))
        throw inspectionFailure();
      seen.add(next.value);
      if (Array.isArray(next.value)) {
        for (let index = 0; index < next.value.length; index++) {
          if (stack.length + count >= MAX_VALUES) throw inspectionFailure();
          stack.push({ value: arrayIndexValue(next.value, index), depth: next.depth + 1 });
        }
        continue;
      }
      for (const key in next.value) {
        if (!Object.hasOwn(next.value, key)) continue;
        if (stack.length + count >= MAX_VALUES) throw inspectionFailure();
        bytes += Buffer.byteLength(key);
        if (bytes > MAX_BYTES) throw inspectionFailure();
        strings.push(key);
        const property = Object.getOwnPropertyDescriptor(next.value, key);
        if (!property || !("value" in property)) throw inspectionFailure();
        stack.push({ value: property.value, depth: next.depth + 1 });
      }
    } else if (
      !["undefined", "number", "boolean"].includes(typeof next.value) &&
      next.value !== null
    ) {
      throw inspectionFailure();
    }
    if (bytes > MAX_BYTES) throw inspectionFailure();
  }
  return strings;
}

function arrayIndexValue(array, index) {
  let depth = 0;
  for (let object = array; object !== null; object = Object.getPrototypeOf(object)) {
    if (++depth > 3) throw inspectionFailure();
    const property = Object.getOwnPropertyDescriptor(object, String(index));
    if (!property) continue;
    if (!("value" in property)) throw inspectionFailure();
    return property.value;
  }
  return undefined;
}

function assertNoSerializationHook(value) {
  let depth = 0;
  for (let object = value; object !== null; object = Object.getPrototypeOf(object)) {
    if (++depth > 3) throw inspectionFailure();
    const property = Object.getOwnPropertyDescriptor(object, "toJSON");
    if (property && (!("value" in property) || typeof property.value === "function"))
      throw inspectionFailure();
  }
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity) => {
    if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()];
    const point =
      entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : original;
  });
}

function decodePath(path) {
  return path.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function sessionAddress() {
  return new Error(
    "Provider transcript contains a session-bound address. Retry provider resolution or inspect the native caption source before retrying.",
  );
}

function inspectionFailure() {
  return new Error(
    "Provider transcript safety inspection is unsupported or exceeds its limits. Inspect the native caption encoding and size before retrying.",
  );
}
