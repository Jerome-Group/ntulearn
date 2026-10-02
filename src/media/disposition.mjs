export const MEDIA_DISPOSITIONS = Object.freeze(["recording", "non-recording", "unresolved"]);

export function recordingDisposition(job) {
  if (job?.disposition && !MEDIA_DISPOSITIONS.includes(job.disposition)) return "unresolved";
  if (job?.disposition === "non-recording") {
    return job.classificationEvidence === "document" ? "non-recording" : "unresolved";
  }
  if (
    job?.disposition === "recording" &&
    job?.provider === "unsupported" &&
    !["media", "adapter"].includes(job.classificationEvidence)
  )
    return "unresolved";
  if (job?.disposition === "unresolved" || job?.disposition === "recording") return job.disposition;
  return job?.provider === "unsupported" ? "unresolved" : "recording";
}
