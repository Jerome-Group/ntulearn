import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { mkdir, lstat, open, rm } from "node:fs/promises";
import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { closeMediaProbeHandle } from "./probe-settlement.mjs";
import { markGlobalMediaSafety, unconfirmedMediaCleanupCode } from "./errors.mjs";
import { armMediaLockAdmission } from "./lock-admission.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { dirname, join, resolve } from "node:path";

const OWNER_FILE = "owner.json";
const SAFETY_MARKER = "safety-armed";
const STALE_LOCK_AFTER_MS = 48 * 60 * 60 * 1_000;

export function mediaQueueLockPath(statePath) {
  return join(dirname(resolve(statePath)), "media-queue.lock");
}

export async function withMediaQueueLock({
  statePath,
  run,
  lockPath = mediaQueueLockPath(statePath),
  now = () => new Date(),
  inspectSafetyMarker = lstat,
  openOwner = open,
  probeTimeoutMs = 5000,
}) {
  if (typeof run !== "function") throw new Error("Media queue lock needs a run function.");
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0 || probeTimeoutMs > 5000)
    throw new Error("Lock metadata needs a positive deadline no longer than five seconds.");
  const releaseAdmission = await armMediaLockAdmission(statePath);
  let release;
  try {
    await assertMediaSafetyAdmission({
      statePath,
      courses: [],
      readQueue: async () => null,
      inspect: (path) => withCapacityDeadline(() => lstat(path), { timeoutMs: probeTimeoutMs }),
    });
    release = await acquire(lockPath, now, {
      inspectSafetyMarker,
      openOwner,
      timeoutMs: probeTimeoutMs,
    });
    await releaseAdmission();
  } catch (error) {
    if (error.code !== "MEDIA_SAFETY_BARRIER_WRITE") {
      if (unconfirmedMediaCleanupCode(error))
        await persistMediaSafetyBarrier({ statePath, error, now });
      await releaseAdmission();
    }
    throw error;
  }
  let retain = false;
  try {
    return await run();
  } catch (error) {
    retain = error?.code === "MEDIA_SAFETY_BARRIER_WRITE";
    if (!retain) {
      try {
        await persistMediaSafetyBarrier({ statePath, error, now });
      } catch (barrierError) {
        retain = true;
        throw barrierError;
      }
    }
    throw error;
  } finally {
    if (!retain) await release();
  }
}

async function acquire(lockPath, now, probes) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST" || !(await stale(lockPath, now, probes))) throw lockHeld();
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  if (!acquired) throw lockHeld();

  try {
    await writeReceipt(join(lockPath, SAFETY_MARKER), "v1\n");
    await writeReceipt(
      join(lockPath, OWNER_FILE),
      `${JSON.stringify({ token, startedAt: now().toISOString(), safetyContainment: "armed" })}\n`,
    );
    await syncDirectory(lockPath);
    await syncDirectory(dirname(lockPath));
  } catch (cause) {
    throw safetyLockFailure(cause);
  }

  return async () => {
    try {
      const owner = await readOwner(lockPath, probes);
      if (owner?.token !== token)
        throw new Error("Owned lock receipt is no longer positively bound.");
      await rm(lockPath, { recursive: true, force: true });
    } catch (cause) {
      throw safetyLockFailure(cause);
    }
  };
}

async function stale(lockPath, now, probes) {
  try {
    await withCapacityDeadline(() => probes.inspectSafetyMarker(join(lockPath, SAFETY_MARKER)), {
      timeoutMs: probes.timeoutMs,
    });
    return false;
  } catch (error) {
    if (unconfirmedMediaCleanupCode(error)) throw error;
    if (error.code !== "ENOENT") return false;
  }
  const owner = await readOwner(lockPath, probes);
  if (
    !owner ||
    owner.safetyContainment !== undefined ||
    typeof owner.token !== "string" ||
    !owner.token
  )
    return false;
  const startedAt = Date.parse(owner.startedAt ?? "");
  return Number.isFinite(startedAt) && now().getTime() - startedAt > STALE_LOCK_AFTER_MS;
}

async function writeReceipt(path, body) {
  return withCapacityDeadline(async (active) => {
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      active();
      await handle.writeFile(body);
      active();
      await handle.sync();
      active();
    } finally {
      await closeMediaProbeHandle(handle);
    }
  });
}

async function readOwner(lockPath, probes) {
  try {
    return await withCapacityDeadline(
      async (active) => {
        const path = join(lockPath, OWNER_FILE);
        const handle = await probes.openOwner(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          active();
          const info = await handle.stat();
          active();
          if (!info.isFile() || info.size > 4096) return null;
          const body = Buffer.alloc(4097);
          let bytes = 0;
          while (bytes < body.length) {
            active();
            const { bytesRead } = await handle.read(body, bytes, body.length - bytes, null);
            active();
            if (!bytesRead) break;
            bytes += bytesRead;
          }
          if (bytes > 4096 || bytes !== info.size) return null;
          const value = JSON.parse(body.subarray(0, bytes).toString("utf8"));
          return value && typeof value === "object" && !Array.isArray(value) ? value : null;
        } finally {
          await closeMediaProbeHandle(handle);
        }
      },
      { timeoutMs: probes.timeoutMs },
    );
  } catch (error) {
    if (unconfirmedMediaCleanupCode(error)) throw error;
    return null;
  }
}

function lockHeld() {
  const error = new Error(
    "An existing media queue lock prevents admission. Confirm owned-run settlement and inspect retained safety evidence before explicitly recovering an abandoned lock.",
  );
  error.code = "MEDIA_QUEUE_LOCK_HELD";
  return error;
}

function safetyLockFailure(cause) {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Media safety lock storage or ownership is unconfirmed. Retain containment; the Owner must qualify storage and owned activity before explicit recovery.",
        { cause },
      ),
      { code: "MEDIA_SAFETY_BARRIER_WRITE" },
    ),
  );
}

async function syncDirectory(path) {
  return withCapacityDeadline(async (active) => {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      active();
      await handle.sync();
      active();
    } finally {
      await closeMediaProbeHandle(handle);
    }
  });
}
