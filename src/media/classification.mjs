import { sessionPath } from "./session-path.mjs";
import { MEDIA_ADDRESS_KEYS } from "./addresses.mjs";
import { directMediaKindOf, directMediaReferenceOf } from "./direct.mjs";
import { externalRecordingAdapters, stableProviderReference } from "./external.mjs";
import { kalturaReferenceOf } from "./kaltura.mjs";
import { youtubeReferenceOf } from "./youtube.mjs";

const NESTED_KEYS = [
  "file",
  "files",
  "attachment",
  "attachments",
  "media",
  "video",
  "audio",
  "resource",
  "resources",
];
const NAME_KEYS = ["fileName", "filename"];
const DOCUMENT_EXTENSIONS = /\.(?:pdf|docx?|pptx?|xlsx?|txt|rtf|csv|odt|ods|odp|srt|vtt|ttml)$/i;
const DOCUMENT_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/rtf",
  "application/ttml+xml",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "text/plain",
  "text/csv",
  "text/vtt",
  "text/srt",
]);

export function classifyRecordingCandidate({
  value,
  sourceKind,
  attachment = null,
  adapters = externalRecordingAdapters,
}) {
  const original = shallowCandidate(value);
  const legacy =
    classifySupported([original, shallowCandidate(attachment)]) ??
    classifyExternal({ value, sourceKind, attachment }, adapters);
  const evidence = candidateEvidence([value, attachment]);
  const classification = classifySupported(evidence.values);
  const identity = legacy?.providerReference;
  const base = legacy ?? {
    provider: "unsupported",
    providerReference: stableProviderReference("unsupported", value),
    retryable: true,
  };
  const candidateReference = stableProviderReference(
    "candidate",
    evidence.values.find(hasAddress) ?? value,
  );
  const common = { ...(identity ? { identityReference: identity } : {}), candidateReference };
  if (evidence.incomplete || evidence.conflict || evidence.mixed) {
    return {
      ...base,
      ...common,
      provider: "unsupported",
      disposition: "unresolved",
      classificationEvidence: "conflicting-or-incomplete",
      limitation:
        "Resource metadata is conflicting or exceeds the bounded inspection. Appearance unresolved; inspect it in NTULearn and run media discovery after metadata is clarified.",
    };
  }
  const sessionAddress = evidence.values.some((candidate) => {
    const fields =
      typeof candidate === "string"
        ? [candidate]
        : MEDIA_ADDRESS_KEYS.map((key) => candidate?.[key]);
    return fields.some((field) => typeof field === "string" && hasSessionDependentPath(field));
  });
  const independentIdentity =
    classification?.provider === "youtube" ||
    (classification?.provider === "kaltura" &&
      classification.providerReference.startsWith("entry:"));
  if (sessionAddress && !independentIdentity) {
    return {
      ...base,
      ...common,
      provider: "unsupported",
      disposition: "unresolved",
      classificationEvidence: "session-dependent-reference",
      retryable: true,
      limitation:
        "Session-bearing source lacks a supported independent acquisition identity. Session values excluded; media identity and completeness remain unresolved. Inspect in NTULearn and rediscover with a stable reference.",
    };
  }
  if (classification)
    return {
      ...classification,
      ...common,
      disposition: "recording",
      classificationEvidence: "media",
    };
  if (evidence.media)
    return {
      ...base,
      ...common,
      disposition: "recording",
      classificationEvidence: "media",
      limitation:
        "Positive media metadata identifies a recording but no supported acquisition reference is available. Inspect the resource and rediscover after an adapter or stable reference is available.",
    };
  if (evidence.document)
    return {
      ...base,
      ...common,
      disposition: "non-recording",
      classificationEvidence: "document",
      retryable: false,
      limitation:
        "Positive document metadata excludes recording acquisition; no transcript completeness is claimed. Re-run media discovery if the resource changes.",
    };
  if (legacy && legacy.provider !== "unsupported")
    return { ...legacy, ...common, disposition: "recording", classificationEvidence: "adapter" };
  if (legacy || ["attachment", "embedded-player", "launch-link"].includes(sourceKind)) {
    return {
      ...base,
      ...common,
      disposition: "unresolved",
      classificationEvidence: "opaque",
      retryable: true,
      limitation:
        "Unsupported resource shape; whether this appearance is a recording is unresolved. Inspect it in NTULearn and run media discovery after positive media or document metadata is available.",
    };
  }
  return null;
}

function classifySupported(values) {
  for (const value of values.filter(Boolean)) {
    const providerReference = kalturaReferenceOf(value);
    if (providerReference) return { provider: "kaltura", providerReference };
  }
  for (const value of values.filter(Boolean)) {
    const providerReference = youtubeReferenceOf(value);
    if (providerReference) return { provider: "youtube", providerReference };
  }
  for (const value of values.filter(Boolean)) {
    const mediaType = directMediaKindOf(value);
    const providerReference = directMediaReferenceOf(value);
    if (mediaType && providerReference) return { provider: "direct", providerReference, mediaType };
  }
  return null;
}

function classifyExternal(candidate, adapters) {
  for (const adapter of adapters ?? []) {
    const classification = adapter?.classify?.(candidate);
    if (classification) return classification;
  }
  return null;
}

function shallowCandidate(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => typeof field === "string"));
}

function hasAddress(value) {
  return (
    typeof value === "string" || MEDIA_ADDRESS_KEYS.some((key) => typeof value?.[key] === "string")
  );
}

function candidateEvidence(roots) {
  const values = [];
  const seen = new WeakSet();
  const references = new Set();
  let visited = 0,
    incomplete = false,
    conflict = false,
    document = false,
    media = false;
  const visit = (value, depth) => {
    if (value == null) return;
    if (++visited > 64 || depth > 4) {
      incomplete = true;
      return;
    }
    if (typeof value === "string") {
      values.push(value);
      const supported = classifySupported([value]);
      if (supported) references.add(`${supported.provider}:${supported.providerReference}`);
      media ||= Boolean(supported);
      document ||=
        /^(?:https?:\/\/|\/)/i.test(value) && DOCUMENT_EXTENSIONS.test(value.split(/[?#]/)[0]);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) {
      incomplete = true;
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 65)) visit(entry, depth + 1);
      if (value.length > 64) incomplete = true;
      return;
    }
    const descriptor = shallowCandidate(value);
    values.push(descriptor);
    const providerIds = new Set();
    for (const address of [descriptor, ...MEDIA_ADDRESS_KEYS.map((key) => descriptor[key])]) {
      const youtube = youtubeReferenceOf(address);
      if (youtube) providerIds.add(`youtube:${youtube}`);
      const kaltura = kalturaReferenceOf(address);
      if (kaltura && !kaltura.startsWith("path:")) providerIds.add(`kaltura:${kaltura}`);
    }
    conflict ||= providerIds.size > 1;
    const supported = classifySupported([descriptor]);
    if (supported) references.add(`${supported.provider}:${supported.providerReference}`);
    const isMedia = Boolean(supported || directMediaKindOf(descriptor));
    const isDocument =
      [value.mimeType, value.contentType, value.type].some(
        (field) =>
          typeof field === "string" && DOCUMENT_MIME.has(field.split(";")[0].trim().toLowerCase()),
      ) ||
      [...NAME_KEYS, ...MEDIA_ADDRESS_KEYS].some(
        (key) =>
          typeof value[key] === "string" && DOCUMENT_EXTENSIONS.test(value[key].split(/[?#]/)[0]),
      );
    conflict ||= isMedia && isDocument;
    document ||= isDocument;
    media ||= isMedia;
    for (const key of NESTED_KEYS)
      if (value[key] && typeof value[key] === "object") visit(value[key], depth + 1);
  };
  for (const root of [...new Set(roots)]) visit(root, 0);
  return {
    values,
    incomplete,
    conflict: conflict || references.size > 1,
    document,
    media,
    mixed: document && media,
  };
}

function hasSessionDependentPath(value) {
  const path = sessionPath(value);
  return path.sessionBearing || path.uncertain;
}
