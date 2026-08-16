import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const OWNER_FILE = "owner.json";
const STALE_LOCK_AFTER_MS = 48 * 60 * 60 * 1_000;

export function mediaQueueLockPath(statePath) {
  return join(dirname(resolve(statePath)), "media-queue.lock");
}

export async function withMediaQueueLock({
  statePath,
  run,
  lockPath = mediaQueueLockPath(statePath),
  now = () => new Date(),
}) {
  if (typeof run !== "function") throw new Error("Media queue lock needs a run function.");
  const release = await acquire(lockPath, now);
  try {
    return await run();
  } finally {
    await release();
  }
}

async function acquire(lockPath, now) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST" || !(await stale(lockPath, now))) throw lockHeld(lockPath);
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  if (!acquired) throw lockHeld(lockPath);

  try {
    await writeFile(
      join(lockPath, OWNER_FILE),
      `${JSON.stringify({ token, startedAt: now().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return async () => {
    const owner = await readOwner(lockPath);
    if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
  };
}

async function stale(lockPath, now) {
  const owner = await readOwner(lockPath);
  const startedAt = Date.parse(owner?.startedAt ?? "");
  if (Number.isFinite(startedAt)) {
    return now().getTime() - startedAt > STALE_LOCK_AFTER_MS;
  }
  const info = await stat(lockPath).catch(() => null);
  return Boolean(info && now().getTime() - info.mtimeMs > STALE_LOCK_AFTER_MS);
}

async function readOwner(lockPath) {
  const raw = await readFile(join(lockPath, OWNER_FILE), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lockHeld(lockPath) {
  const error = new Error(`Another media queue run holds ${lockPath}.`);
  error.code = "MEDIA_QUEUE_LOCK_HELD";
  return error;
}
