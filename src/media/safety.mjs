import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { unconfirmedMediaCleanupCode, markGlobalMediaSafety, publicMediaError } from "./errors.mjs";

export function mediaSafetyPath(statePath) {
  return join(dirname(resolve(statePath)), "media-safety.json");
}

export async function assertMediaSafetyAdmission({
  statePath,
  courses,
  readQueue,
  inspect = lstat,
}) {
  try {
    await inspect(mediaSafetyPath(statePath));
  } catch (error) {
    if (error.code !== "ENOENT") throw admissionFailure(error);
    for (const course of courses) {
      let loaded;
      try {
        loaded = await readQueue({ statePath, courseKey: course.key, course });
      } catch (cause) {
        throw admissionFailure(cause);
      }
      if (loaded?.record?.queue?.some((job) => job.safetyFailure !== undefined))
        throw admissionFailure();
    }
    return;
  }
  throw admissionFailure();
}

export async function persistMediaSafetyBarrier({
  statePath,
  error,
  now = () => new Date(),
  createDirectory = mkdir,
  openBarrier = open,
}) {
  const code = unconfirmedMediaCleanupCode(error);
  if (!code) return;
  const path = mediaSafetyPath(statePath);
  let handle;
  try {
    await createDirectory(dirname(path), { recursive: true });
    try {
      handle = await openBarrier(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
    } catch (cause) {
      if (cause.code === "EEXIST") return;
      throw cause;
    }
    await handle.writeFile(
      `${JSON.stringify({ version: 1, code, recordedAt: now().toISOString() })}\n`,
    );
    await handle.sync();
  } catch (cause) {
    throw markGlobalMediaSafety(
      Object.assign(
        new Error(
          "Unconfirmed media cleanup could not persist its admission barrier. Retain external containment; inspect owned processes/browser and storage before any retry.",
          { cause },
        ),
        { code: "MEDIA_SAFETY_BARRIER_WRITE" },
      ),
    );
  } finally {
    await closeBarrier(handle);
  }
}

async function closeBarrier(handle) {
  try {
    await handle?.close();
  } catch (cause) {
    throw markGlobalMediaSafety(
      Object.assign(
        new Error(
          "Media safety barrier descriptor closure is unconfirmed. Retain external containment and inspect storage before any retry.",
          { cause },
        ),
        { code: "MEDIA_SAFETY_BARRIER_WRITE" },
      ),
    );
  }
}

function admissionFailure(cause) {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        `Media admission is blocked by retained or unreadable safety evidence${cause ? `: ${publicMediaError(cause)}` : ""}. The Owner must verify owned process/browser cessation and inspect preserved evidence before explicitly clearing the barrier and queue safety markers; do not automatically retry.`,
        { cause },
      ),
      { code: "MEDIA_SAFETY_BARRIER" },
    ),
  );
}
