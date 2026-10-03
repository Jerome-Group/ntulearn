import { recordingDisposition } from "./disposition.mjs";

export function isMediaJobComplete(job) {
  return (
    recordingDisposition(job) === "recording" &&
    job?.complete === true &&
    job?.transcript?.reviewRequired !== true &&
    !(Array.isArray(job?.transcript?.flags) && job.transcript.flags.length) &&
    job?.transcript?.complete === true
  );
}
