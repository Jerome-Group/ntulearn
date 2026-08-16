import { absoluteUrl } from "../ntulearn/urls.mjs";
import { directMediaKindOf, directMediaReferenceOf } from "./direct.mjs";
import { kalturaReferenceOf } from "./kaltura.mjs";
import { youtubeReferenceOf } from "./youtube.mjs";

export function classifyRecordingCandidate({ value, sourceKind, attachment = null }) {
  const values = [value, attachment].filter(Boolean);
  for (const candidate of values) {
    const providerReference = kalturaReferenceOf(candidate);
    if (providerReference) return { provider: "kaltura", providerReference };
  }
  for (const candidate of values) {
    const providerReference = youtubeReferenceOf(candidate);
    if (providerReference) return { provider: "youtube", providerReference };
  }
  for (const candidate of values) {
    const mediaType = directMediaKindOf(candidate);
    const providerReference = directMediaReferenceOf(candidate);
    if (mediaType && providerReference) {
      return { provider: "direct", providerReference, mediaType };
    }
  }

  if (sourceKind === "embedded-player" || sourceKind === "launch-link") {
    return {
      provider: "unsupported",
      providerReference: unsupportedReferenceOf(value),
      retryable: true,
      limitation: `Unsupported recording provider shape from ${sourceKind}; media acquisition is unavailable.`,
    };
  }
  return null;
}

function unsupportedReferenceOf(value) {
  const address = addressOf(value);
  if (address) {
    try {
      const parsed = new URL(absoluteUrl(address));
      const identity = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
      if (identity) return `unsupported:${safeIdentity(identity)}`;
    } catch {
      // Fall through to a stable value for a malformed provider address.
    }
  }
  return `unsupported:${safeIdentity(String(value ?? "opaque"))}`;
}

function addressOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return ["resourceUrl", "viewerUrl", "url", "href", "src", "launchUrl", "launchLink"]
    .map((key) => value[key])
    .find((candidate) => typeof candidate === "string" && candidate);
}

function safeIdentity(value) {
  return (
    String(value)
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._/-]/g, "_")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "") || "opaque"
  );
}
