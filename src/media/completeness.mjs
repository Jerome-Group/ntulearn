import { recordingDisposition } from "./disposition.mjs";

export function isMediaJobComplete(job) {
  return (
    recordingDisposition(job) === "recording" &&
    job?.complete === true &&
    job?.transcript?.complete === true
  );
}
