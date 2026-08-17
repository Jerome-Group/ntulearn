import { createHash } from "node:crypto";
import { absoluteUrl } from "../ntulearn/urls.mjs";
import { MEDIA_ADDRESS_KEYS } from "./addresses.mjs";
import { publicMediaError } from "./errors.mjs";

const ADDRESS_KEYS = MEDIA_ADDRESS_KEYS;
const FILE_SHAPE_KEYS = Object.freeze([
  "fileName",
  "filename",
  "mimeType",
  "contentType",
  "fileSize",
  "fileType",
  "permanentUrl",
  "uploadId",
]);
const CAPTION_MIME_TYPES = new Set(["application/ttml+xml", "text/srt", "text/vtt"]);
const CAPTION_EXTENSIONS = new Set([".srt", ".ttml", ".vtt"]);
const ID_KEYS = Object.freeze([
  "recordingId",
  "recording_id",
  "mediaId",
  "media_id",
  "videoId",
  "video_id",
  "entryId",
  "entry_id",
  "activityId",
  "activity_id",
  "placementId",
  "placement_id",
  "resourceId",
  "resource_id",
  "contentId",
  "content_id",
  "id",
]);
const PROVIDER_KEYS = Object.freeze([
  "provider",
  "providerName",
  "platform",
  "vendor",
  "tool",
  "toolName",
  "service",
  "application",
  "ltiProvider",
  "contentHandler",
]);
const STABLE_QUERY_KEYS = new Set(ID_KEYS);
const EPHEMERAL_PARAMETER_PATTERN =
  /\b(ks|access_token|id_token|launch_token|launch|token|session|signature|cookie|state|sig)\s*=\s*[^\s&]+/gi;
const PROVIDER_NAMES = Object.freeze({
  blackboard: "Blackboard",
  cengage: "Cengage",
  feedbackfruits: "FeedbackFruits",
  "ntulearn-file": "NTULearn file",
  padlet: "Padlet",
  turnitin: "Turnitin",
});

export function createExternalShapeAdapter({
  provider,
  matches,
  referenceOf = ({ value }) => stableProviderReference(provider, value),
  outputProvider = provider,
  providerName = displayName(provider),
  limitation = `The ${providerName} recording adapter cannot acquire this appearance yet.`,
  resolve = null,
  transcript = () => null,
  media = null,
}) {
  assertProviderName(provider);
  if (typeof matches !== "function") throw new Error(`${provider} adapter needs matches.`);
  if (typeof referenceOf !== "function") {
    throw new Error(`${provider} adapter needs referenceOf.`);
  }
  if (resolve !== null && typeof resolve !== "function") {
    throw new Error(`${provider} adapter resolve must be a function or null.`);
  }
  if (typeof transcript !== "function") {
    throw new Error(`${provider} adapter transcript must be a function.`);
  }
  if (media !== null && typeof media !== "function") {
    throw new Error(`${provider} adapter media must be a function or null.`);
  }
  const safeLimitation = publicMediaError(limitation);

  return Object.freeze({
    provider,
    classify(candidate) {
      if (!matches(candidate)) return null;
      const providerReference = normalizeProviderReference(provider, referenceOf(candidate));
      if (typeof providerReference !== "string" || !providerReference.trim()) return null;

      const classification = {
        provider: outputProvider,
        providerName,
        providerShape: provider,
        providerReference:
          outputProvider === "unsupported"
            ? unsupportedReference(provider, providerReference)
            : providerReference,
      };
      if (outputProvider === "unsupported") {
        classification.retryable = true;
        classification.limitation = safeLimitation;
      }
      return classification;
    },
    createProvider() {
      return createExternalMediaProvider({
        name: provider,
        resolve:
          resolve ??
          (() => {
            throw new Error(`${providerName} recording acquisition is not configured.`);
          }),
        transcript,
        media:
          media ??
          (() => ({
            kind: "unavailable",
            limitation: safeLimitation,
            retryable: true,
          })),
      });
    },
  });
}

export function createExternalMediaProvider({ name, resolve, transcript = () => null, media }) {
  assertProviderName(name);
  if (typeof resolve !== "function") throw new Error(`${name} provider needs resolve.`);
  if (typeof transcript !== "function") throw new Error(`${name} provider needs transcript.`);
  if (typeof media !== "function") throw new Error(`${name} provider needs media.`);

  return {
    name,
    resolve(appearance, context = {}) {
      return resolve({
        appearance,
        reference: appearance?.providerReference,
        fresh: true,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    },
    transcript(resolved, context = {}) {
      return transcript(resolved, context);
    },
    media(resolved, context = {}) {
      return media(resolved, context);
    },
  };
}

export const externalRecordingAdapters = Object.freeze([
  ntulearnFileAdapter(),
  knownProviderAdapter("feedbackfruits", ["feedbackfruits"]),
  knownProviderAdapter("cengage", ["cengage", "webassign"]),
  knownProviderAdapter("blackboard", ["blackboard", "blti"]),
  knownProviderAdapter("padlet", ["padlet"]),
  knownProviderAdapter("turnitin", ["turnitin"]),
]);

export function providerForRecording({ appearance, adapters = externalRecordingAdapters }) {
  const providerKey = appearance?.providerShape ?? appearance?.provider;
  const adapter = (adapters ?? []).find((candidate) => candidate?.provider === providerKey);
  if (adapter?.createProvider) return adapter.createProvider();

  const limitation = `No recording provider adapter is registered for ${providerKey ?? "unknown"}.`;
  return createExternalMediaProvider({
    name: "unsupported",
    resolve: () => {
      throw new Error(limitation);
    },
    media: () => ({ kind: "unavailable", limitation, retryable: true }),
  });
}

export function stableProviderReference(provider, value) {
  assertProviderName(provider);
  const prefix = provider === "unsupported" ? "unsupported" : safeIdentity(provider);
  const id = stableIdOf(value);
  if (id) return `${prefix}:id:${safeIdentity(id)}`;

  const address = addressOf(value);
  const addressParts = stableAddressParts(address);
  if (addressParts) {
    return `${prefix}:${safeIdentity(addressParts.identity)}${
      addressParts.query ? `?${addressParts.query}` : ""
    }`;
  }

  return `${prefix}:opaque:${shapeDigest(value)}`;
}

function knownProviderAdapter(provider, signals) {
  return createExternalShapeAdapter({
    provider,
    outputProvider: "unsupported",
    matches: (candidate) =>
      ["embedded-player", "launch-link"].includes(candidate?.sourceKind) &&
      matchesKnownProvider(candidate, signals),
    limitation: `${displayName(provider)} content is visible but its recording acquisition path is unavailable.`,
  });
}

function ntulearnFileAdapter() {
  return createExternalShapeAdapter({
    provider: "ntulearn-file",
    outputProvider: "unsupported",
    matches: ({ value, sourceKind }) =>
      ["attachment", "embedded-player"].includes(sourceKind) && isFileShape(value),
    limitation: "NTULearn file-shaped reference is visible but is not a recording.",
  });
}

function isFileShape(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return false;
  const hasAddress = ADDRESS_KEYS.some(
    (key) => typeof value[key] === "string" && value[key].trim(),
  );
  if (
    hasAddress &&
    FILE_SHAPE_KEYS.some((key) => value[key] !== undefined) &&
    !isCaptionFile(value)
  ) {
    return true;
  }
  return isFileShape(value.file, depth + 1);
}

function isCaptionFile(value) {
  if (CAPTION_MIME_TYPES.has(String(value.mimeType ?? value.contentType ?? "").toLowerCase())) {
    return true;
  }
  const name = value.fileName ?? value.filename ?? value.name;
  if (typeof name !== "string") return false;
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return CAPTION_EXTENSIONS.has(extension);
}

function matchesKnownProvider(candidate, signals) {
  const values = candidateValues(candidate?.value);
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim().toLowerCase();
    if (!text) continue;
    if (signals.some((signal) => providerSignalMatches(text, signal))) return true;
  }
  return false;
}

function providerSignalMatches(value, signal) {
  if (value === signal || value.includes(signal)) {
    if (!value.includes("://") && !value.startsWith("/")) return true;
  }
  if (!addressLike(value)) return false;
  try {
    const parsed = new URL(absoluteUrl(value));
    return parsed.hostname.includes(signal) || parsed.pathname.toLowerCase().includes(signal);
  } catch {
    return false;
  }
}

function candidateValues(value, depth = 0) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || depth > 2) return [];

  const values = [];
  for (const key of [...ADDRESS_KEYS, ...PROVIDER_KEYS]) {
    const nested = value[key];
    if (typeof nested === "string") values.push(nested);
    else if (nested && typeof nested === "object")
      values.push(...candidateValues(nested, depth + 1));
  }
  return values;
}

function stableIdOf(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  for (const key of ID_KEYS) {
    const candidate = value[key];
    if (
      typeof candidate === "string" &&
      candidate.trim() &&
      !addressLike(candidate) &&
      !containsEphemeralParameter(candidate)
    ) {
      return candidate.trim();
    }
  }
  for (const key of [...ADDRESS_KEYS, ...PROVIDER_KEYS]) {
    const id = stableIdOf(value[key], depth + 1);
    if (id) return id;
  }
  return null;
}

function addressOf(value, depth = 0) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  for (const key of ADDRESS_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }
  for (const key of [...PROVIDER_KEYS, "placement", "launch"]) {
    const address = addressOf(value[key], depth + 1);
    if (address) return address;
  }
  return null;
}

function stableQuery(parsed) {
  return [...parsed.searchParams.entries()]
    .filter(([key, value]) => STABLE_QUERY_KEYS.has(key) && value)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${safeIdentity(key)}=${safeIdentity(value)}`)
    .join("&");
}

function unsupportedReference(provider, reference) {
  const prefix = `${safeIdentity(provider)}:`;
  const body = reference.startsWith(prefix)
    ? reference.slice(prefix.length)
    : safeIdentity(reference);
  return `unsupported:${safeIdentity(provider)}:${body}`;
}

function normalizeProviderReference(provider, reference) {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const text = reference.trim();
  if (addressLike(text) || text.includes("://")) {
    return stableProviderReference(provider, text);
  }
  const prefix = `${safeIdentity(provider)}:`;
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  if (EPHEMERAL_PARAMETER_PATTERN.test(body)) {
    EPHEMERAL_PARAMETER_PATTERN.lastIndex = 0;
    return `${prefix}opaque:${shapeDigest(body)}`;
  }
  EPHEMERAL_PARAMETER_PATTERN.lastIndex = 0;
  return `${prefix}${safeIdentity(body)}`;
}

function shapeDigest(value) {
  return createHash("sha256").update(shapeOf(value)).digest("hex").slice(0, 16);
}

function shapeOf(value, seen = new WeakSet(), key = "") {
  if (isEphemeralKey(key)) return "sensitive";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "circular";
    seen.add(value);
    const result = `array:${value.length}:${value
      .map((item) => shapeOf(item, seen, key))
      .join(",")}`;
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "circular";
    seen.add(value);
    const result = Object.keys(value)
      .sort()
      .map((childKey) => `${childKey}:${shapeOf(value[childKey], seen, childKey)}`)
      .join("|");
    seen.delete(value);
    return result;
  }
  if (typeof value === "string") {
    const addressParts = stableAddressParts(value);
    if (addressParts) {
      return `address:${addressParts.identity}${
        addressParts.query ? `?${addressParts.query}` : ""
      }`;
    }
    return `text:${redactEphemeralParameters(value)}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function stableAddressParts(value) {
  if (!addressLike(value)) return null;
  try {
    const parsed = new URL(absoluteUrl(value));
    const identity = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    return identity ? { identity, query: stableQuery(parsed) } : null;
  } catch {
    return null;
  }
}

function redactEphemeralParameters(value) {
  return value.replace(EPHEMERAL_PARAMETER_PATTERN, "$1=[redacted]").trim();
}

function isEphemeralKey(value) {
  if (!value) return false;
  const normalized = value.replace(/[A-Z]/g, (letter) => `_${letter}`).toLowerCase();
  return /^(?:ks|access_token|id_token|launch_token|token|session|session_id|signature|cookie|state|sig)$/.test(
    normalized,
  );
}

function addressLike(value) {
  return typeof value === "string" && /^(?:https?:\/\/|\/)/i.test(value.trim());
}

function containsEphemeralParameter(value) {
  return /(?:^|[?&])(?:ks|access_token|id_token|launch_token|launch|token|session|signature|cookie|state|sig)\s*=/i.test(
    value,
  );
}

function displayName(provider) {
  return PROVIDER_NAMES[provider] ?? String(provider);
}

function safeIdentity(value) {
  return (
    String(value)
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._:/-]/g, "_")
      .replace(/\/{2,}/g, "/")
      .replace(/^[/.:]+|[/.:]+$/g, "") || "opaque"
  );
}

function assertProviderName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Media provider names must be simple identifiers.");
  }
}
