import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { lstat, realpath, stat, statfs as readSpace } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { markGlobalMediaSafety } from "./errors.mjs";
import { assertMediaRoot, MEDIA_VOLUME_ROOT, mediaRuntimePaths } from "./paths.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";

const RECOVERY = "Free space or restore the mounted storage, then retry the media worker.";

export function createMediaCapacity(media, { timeoutMs = 5_000, ...options } = {}) {
  return withCapacityDeadline(
    () =>
      initializeCapacity(media, options, timeoutMs).catch((error) => {
        if (error.globalSafety) throw error;
        throw safety("Media capacity initialization could not verify mounted storage.", error);
      }),
    { timeoutMs },
  );
}

async function initializeCapacity(
  media,
  { volumeRoot = MEDIA_VOLUME_ROOT, courses = [], statfs = readSpace },
  timeoutMs,
) {
  const mediaRoot = assertMediaRoot(media?.mediaRoot, volumeRoot);
  const reserve = media.freeSpaceReserveBytes;
  if (!Number.isSafeInteger(reserve) || reserve <= 0)
    throw safety("Media reserve is not configured.");
  const volume = await snapshot(resolve(volumeRoot));
  const store = await snapshot(mediaRoot);
  if (
    !inside(volume.canonical, store.canonical) ||
    store.canonical === volume.canonical ||
    !(await stat(mediaRoot)).isDirectory()
  ) {
    throw safety("Media store is unavailable or outside its verified volume.");
  }
  const roots = new Map();
  const runtime = mediaRuntimePaths(mediaRoot);
  const monitored = [
    mediaRoot,
    runtime.root,
    runtime.bin,
    runtime.models,
    runtime.cache,
    runtime.temp,
    runtime.work,
    runtime.metadata,
  ];
  for (const root of [
    ...monitored,
    ...courses.map((course) => course.destination).filter(Boolean),
  ]) {
    const path = resolve(root);
    roots.set(path, await snapshot(path));
  }

  function check(request) {
    return withCapacityDeadline(() => inspectCapacity(request), { timeoutMs });
  }

  async function inspectCapacity({ path = mediaRoot, boundary = mediaRoot, bytes = 0 } = {}) {
    try {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw safety("Media write size is unknown.");
      if (!sameSnapshot(await snapshot(resolve(volumeRoot)), volume))
        throw safety("Media volume changed after runtime verification.");
      for (const root of monitored) {
        await unchanged(root);
        await assertMediaArtifactPath(join(root, ".capacity-probe"), mediaRoot);
      }
      const destination = resolve(boundary);
      if (!roots.has(destination)) throw safety("Media destination was not verified for this run.");
      await unchanged(destination);
      const target = resolve(path);
      await assertMediaArtifactPath(
        target === destination ? join(target, ".capacity-probe") : target,
        destination,
      );
      const { ancestor } = await existingAncestor(target);
      const evidence = await statfs(ancestor, { bigint: true });
      const available = availableBytes(evidence);
      if (available < BigInt(reserve) + BigInt(bytes)) {
        throw safety(
          `Media capacity cannot keep the configured reserve after writing ${bytes} bytes.`,
        );
      }
    } catch (error) {
      if (error.globalSafety) throw error;
      throw safety("Media capacity check could not verify storage.", error);
    }
  }

  async function unchanged(root) {
    const path = resolve(root);
    if (!sameSnapshot(await snapshot(path), roots.get(path)))
      throw safety("Media canonical storage path changed during this run.");
  }

  await check();
  return {
    check,
    async checkJob(course) {
      await check();
      if (course?.destination)
        await check({ path: course.destination, boundary: course.destination });
    },
  };
}

async function snapshot(path) {
  const { ancestor, suffix } = await existingAncestor(path);
  const info = await stat(ancestor);
  return {
    canonical: resolve(await realpath(ancestor), suffix),
    device: info.dev,
    inode: ancestor === path ? info.ino : null,
  };
}

function sameSnapshot(current, initial) {
  return (
    current.canonical === initial.canonical &&
    current.device === initial.device &&
    (initial.inode === null || current.inode === initial.inode)
  );
}

async function existingAncestor(path) {
  let ancestor = resolve(path);
  while (true) {
    const info = await lstat(ancestor).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw safety("Media storage path cannot be inspected.", error);
    });
    if (info) return { ancestor, suffix: relative(ancestor, path) };
    const parent = dirname(ancestor);
    if (parent === ancestor) throw safety("Media storage has no available filesystem.");
    ancestor = parent;
  }
}

function availableBytes(evidence) {
  try {
    const { bavail, bsize } = evidence;
    for (const value of [bavail, bsize]) {
      if (typeof value !== "bigint" && !Number.isSafeInteger(value)) throw new Error();
      if (value < 0) throw new Error();
    }
    if (bsize === 0 || bsize === 0n) throw new Error();
    return BigInt(bavail) * BigInt(bsize);
  } catch {
    throw safety("Media free-space evidence is missing or invalid.");
  }
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function safety(message, cause) {
  return markGlobalMediaSafety(new Error(`${message} ${RECOVERY}`, { cause }));
}
