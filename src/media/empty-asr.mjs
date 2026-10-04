import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";

// An explicit empty native array describes recognition output, never acoustic absence.
export function isRecognizedEmptyNative(native) {
  if (!native || typeof native !== "object") return false;
  const transcription = Object.getOwnPropertyDescriptor(native, "transcription");
  const segments = Object.getOwnPropertyDescriptor(native, "segments");
  const properties = [transcription, segments].filter(Boolean);
  if (
    !properties.length ||
    properties.some(
      (property) =>
        !("value" in property) || !Array.isArray(property.value) || property.value.length !== 0,
    )
  )
    return false;
  safeNativeTranscriptBody(native);
  // Native records are not body/content wrappers: inspect their entire serialized record too.
  safeNativeTranscriptBody(JSON.stringify(native));
  return true;
}
