import { directMediaKindOf, directMediaReferenceOf } from "./direct.mjs";
import { externalRecordingAdapters, stableProviderReference } from "./external.mjs";
import { kalturaReferenceOf } from "./kaltura.mjs";
import { youtubeReferenceOf } from "./youtube.mjs";

export function classifyRecordingCandidate({
  value,
  sourceKind,
  attachment = null,
  adapters = externalRecordingAdapters,
}) {
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

  for (const adapter of adapters ?? []) {
    const classification = adapter?.classify?.({ value, sourceKind, attachment });
    if (classification) return classification;
  }

  if (sourceKind === "embedded-player" || sourceKind === "launch-link") {
    return {
      provider: "unsupported",
      providerReference: stableProviderReference("unsupported", value),
      retryable: true,
      limitation: `Unsupported recording provider shape from ${sourceKind}; media acquisition is unavailable.`,
    };
  }
  return null;
}
