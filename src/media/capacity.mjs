import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { lstat, realpath, stat, statfs as readSpace } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { markGlobalMediaSafety } from "./errors.mjs";
import { assertMediaRoot, MEDIA_VOLUME_ROOT, mediaRuntimePaths } from "./paths.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";

const RECOVERY = "Free space or restore the mounted storage, then retry the media worker.";

export function createMediaCapacity(media, { timeoutMs = 5_000, ...options } = {}) {
  return withCapacityDeadline(
    (active) =>
      initializeCapacity(media, options, timeoutMs, active).catch((error) => {
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
  active,
) {
  const mediaRoot = assertMediaRoot(media?.mediaRoot, volumeRoot);
  const reserve = media.freeSpaceReserveBytes;
  if (!Number.isSafeInteger(reserve) || reserve <= 0)
    throw safety("Media reserve is not configured.");
  const volume = await snapshot(resolve(volumeRoot), active);
  const store = await snapshot(mediaRoot, active);
  if (
    !inside(volume.canonical, store.canonical) ||
    store.canonical === volume.canonical ||
    !(await inspectedStat(mediaRoot, active)).isDirectory()
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
    roots.set(path, await snapshot(path, active));
  }

  const courseRoots = new Map(
    courses
      .filter((course) => course.destination)
      .map((course) => {
        const path = resolve(course.destination);
        return [path, roots.get(path)];
      }),
  );

  function check(request) {
    return withCapacityDeadline((checkActive) => inspectCapacity(request, checkActive), {
      timeoutMs,
    });
  }

  async function inspectCapacity(
    { path = mediaRoot, boundary = mediaRoot, bytes = 0 } = {},
    active,
  ) {
    try {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw safety("Media write size is unknown.");
      if (!sameSnapshot(await snapshot(resolve(volumeRoot), active), volume))
        throw safety("Media volume changed after runtime verification.");
      for (const root of monitored) {
        await unchanged(root, active);
        await assertMediaArtifactPath(join(root, ".capacity-probe"), mediaRoot, { active });
      }
      const destination = resolve(boundary);
      const courseBinding = await verifyDestination(destination, active);
      const target = resolve(path);
      await assertMediaArtifactPath(
        target === destination ? join(target, ".capacity-probe") : target,
        destination,
        { active },
      );
      const { ancestor } = await existingAncestor(target, active);
      active();
      const evidence = await statfs(ancestor, { bigint: true });
      active();
      if (courseBinding) await assertCourseBinding(destination, courseBinding, active);
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

  async function verifyDestination(destination, active) {
    if (roots.has(destination)) {
      await unchanged(destination, active);
      return courseRoots.has(destination)
        ? { configured: destination, initial: courseRoots.get(destination) }
        : null;
    }
    const current = await snapshot(destination, active);
    const matches = [...courseRoots].filter(([, initial]) => sameSnapshot(current, initial));
    if (matches.length !== 1) throw unverifiedDestination();
    const [configured, initial] = matches[0];
    const binding = { configured, initial };
    await assertCourseBinding(destination, binding, active);
    return binding;
  }

  async function assertCourseBinding(destination, { configured, initial }, active) {
    await unchanged(configured, active);
    if (!sameSnapshot(await snapshot(destination, active), initial)) throw unverifiedDestination();
  }

  async function unchanged(root, active) {
    const path = resolve(root);
    if (!sameSnapshot(await snapshot(path, active), roots.get(path)))
      throw safety("Media canonical storage path changed during this run.");
  }

  await check();
  active();
  return {
    check,
    async checkJob(course) {
      await check();
      if (course?.destination)
        await check({ path: course.destination, boundary: course.destination });
    },
  };
}

async function snapshot(path, active) {
  const { ancestor, suffix } = await existingAncestor(path, active);
  const info = await inspectedStat(ancestor, active);
  active();
  const canonical = resolve(await realpath(ancestor), suffix);
  active();
  return {
    canonical,
    device: info.dev,
    inode: ancestor === path ? info.ino : null,
  };
}

async function inspectedStat(path, active) {
  active();
  const info = await stat(path);
  active();
  return info;
}

function sameSnapshot(current, initial) {
  return (
    current.canonical === initial.canonical &&
    current.device === initial.device &&
    (initial.inode === null || current.inode === initial.inode)
  );
}

async function existingAncestor(path, active) {
  let ancestor = resolve(path);
  while (true) {
    active();
    const info = await lstat(ancestor).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw safety("Media storage path cannot be inspected.", error);
    });
    active();
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

function unverifiedDestination() {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Media destination was not verified for this run. Restore the configured course folder and its retained alias before retrying the media worker.",
      ),
      { code: "MEDIA_CAPACITY_DESTINATION_UNVERIFIED" },
    ),
  );
}
