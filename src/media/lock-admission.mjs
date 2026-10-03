import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { closeMediaProbeHandle } from "./probe-settlement.mjs";
import { markGlobalMediaSafety } from "./errors.mjs";

export function mediaLockAdmissionPath(statePath) {
  return join(dirname(resolve(statePath)), "media-lock-admission.json");
}

export async function armMediaLockAdmission(statePath, { timeoutMs = 5000 } = {}) {
  const path = mediaLockAdmissionPath(statePath);
  const body = Buffer.from(`${JSON.stringify({ version: 1, token: randomUUID() })}\n`);
  let identity;
  try {
    await withCapacityDeadline(
      async (active) => {
        await mkdir(dirname(path), { recursive: true });
        active();
        const handle = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        ).catch((error) => {
          if (error.code === "EEXIST") throw admissionRefused();
          throw error;
        });
        try {
          active();
          await handle.writeFile(body);
          active();
          await handle.sync();
          active();
          identity = await handle.stat();
          active();
        } finally {
          await closeMediaProbeHandle(handle);
        }
        active();
        await syncParent(path, active);
      },
      { timeoutMs },
    );
  } catch (cause) {
    if (cause.code === "MEDIA_SAFETY_BARRIER") throw cause;
    throw admissionStorageFailure(cause);
  }
  return async () => {
    try {
      await withCapacityDeadline(
        async (active) => {
          const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            active();
            const before = await handle.stat();
            active();
            if (!matches(before, identity)) throw new Error("Admission marker ownership changed.");
            const current = Buffer.alloc(body.length + 1);
            let bytes = 0;
            while (bytes < current.length) {
              active();
              const { bytesRead } = await handle.read(current, bytes, current.length - bytes, null);
              active();
              if (!bytesRead) break;
              bytes += bytesRead;
            }
            if (bytes !== body.length || !current.subarray(0, bytes).equals(body))
              throw new Error("Admission marker token changed.");
            const after = await handle.stat();
            active();
            const leaf = await lstat(path);
            active();
            if (!matches(after, identity) || !matches(leaf, identity))
              throw new Error("Admission marker binding changed.");
          } finally {
            await closeMediaProbeHandle(handle);
          }
        },
        { timeoutMs },
      );
      // Removal follows positive metadata/read/close settlement and another durable guard.
      await unlink(path);
      await withCapacityDeadline((active) => syncParent(path, active), { timeoutMs });
    } catch (cause) {
      throw admissionStorageFailure(cause);
    }
  };
}

function matches(current, original) {
  return (
    current.isFile() &&
    !current.isSymbolicLink?.() &&
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.size === original.size &&
    current.mtimeMs === original.mtimeMs &&
    current.ctimeMs === original.ctimeMs
  );
}

async function syncParent(path, active) {
  active();
  const handle = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    active();
    await handle.sync();
    active();
  } finally {
    await closeMediaProbeHandle(handle);
  }
}

export function admissionRefused() {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Media lock admission is pending or retained. Confirm owned activity and storage settlement; the Owner must qualify the exact retained admission evidence before recovery.",
      ),
      { code: "MEDIA_SAFETY_BARRIER" },
    ),
  );
}

function admissionStorageFailure(cause) {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Media lock admission evidence storage or cleanup is unconfirmed. Retain external containment and preserved admission evidence; do not retry until Owner-qualified recovery.",
        { cause },
      ),
      { code: "MEDIA_SAFETY_BARRIER_WRITE" },
    ),
  );
}
