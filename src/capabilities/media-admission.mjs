import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { mediaLockAdmissionPath } from "../media/lock-admission.mjs";
import { mediaSafetyPath } from "../media/safety.mjs";
import { mediaQueueLockPath } from "../media/lock.mjs";
import { withCapacityDeadline } from "../media/capacity-deadline.mjs";
import { observation } from "./result.mjs";

export async function mediaAdmissionObservation(statePath, inspect = lstat) {
  if (typeof statePath !== "string")
    return observation(
      "media-admission",
      "unrun",
      "MEDIA_ADMISSION_UNRUN",
      "No configured state binding; admission observation unrun.",
    );
  let present = 0;
  try {
    for (const path of [
      mediaLockAdmissionPath(statePath),
      mediaSafetyPath(statePath),
      join(mediaQueueLockPath(statePath), "safety-armed"),
    ]) {
      try {
        await withCapacityDeadline(() => inspect(path));
        present++;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } catch {
    return observation(
      "media-admission",
      "failed",
      "MEDIA_ADMISSION_UNCONFIRMED",
      "Admission evidence metadata is unconfirmed; no activity or cessation inference.",
      "Retain containment; Owner qualifies owned activity and exact private storage evidence before recovery.",
    );
  }
  return observation(
    "media-admission",
    present ? "blocked" : "passed",
    present ? "MEDIA_ADMISSION_RETAINED_OR_ACTIVE" : "MEDIA_ADMISSION_MARKERS_ABSENT",
    "Fixed safety-marker metadata only; presence may be active or retained, and absence proves no process settlement.",
    present
      ? "Await positively owned settlement or Owner-qualified recovery; never automatically clear admission evidence."
      : null,
    { markersPresent: present },
  );
}
