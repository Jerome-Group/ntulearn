import { mediaAdmissionObservation } from "./media-admission.mjs";
import { lstat, realpath, statfs } from "node:fs/promises";
import { relative, isAbsolute, join } from "node:path";
import { loadConfig } from "../config.mjs";
import { mediaRuntimePaths } from "../media/paths.mjs";
import { readEvidence } from "./read.mjs";
import { capabilityResult, observation } from "./result.mjs";

export async function readLocalConfig(root, configPath, load = loadConfig) {
  try {
    return { config: await load(root, configPath) };
  } catch (error) {
    return {
      check: observation(
        "configuration",
        error.cause?.code === "ENOENT" ? "blocked" : "failed",
        "CONFIG_UNAVAILABLE",
        "Local configuration is missing or invalid; details stay private.",
        "Copy config/courses.example.json to config/courses.json; validate fields locally.",
      ),
    };
  }
}

export async function localHealth({
  root,
  configPath,
  nodeVersion,
  load,
  inspect = lstat,
  canonical = realpath,
  space = statfs,
  read = readEvidence,
}) {
  const loaded = await readLocalConfig(root, configPath, load);
  const supported = supportedNode(nodeVersion);
  const checks = [
    observation(
      "node",
      supported ? "passed" : "failed",
      supported ? "NODE_SUPPORTED" : "NODE_UNSUPPORTED",
      "Node must be 22.13+ on 22.x, or 24+.",
      supported ? null : "Use a supported Node version, then npm ci --ignore-scripts.",
      { version: nodeVersion },
    ),
  ];
  if (!loaded.config) return capabilityResult("health", [...checks, loaded.check]);
  const config = loaded.config;
  checks.push(await mediaAdmissionObservation(config.statePath, inspect));
  checks.push(
    observation(
      "configuration",
      "passed",
      "CONFIG_VALID",
      "Configuration parsed; course contents and paths are excluded.",
      null,
      {
        courses: config.courses.length,
        mediaEnabled: config.courses.filter((course) => course.mediaMode !== "off").length,
      },
    ),
  );
  const profile = await metadata(config.profilePath, inspect);
  const privateProfile =
    profile?.isDirectory() && !profile.isSymbolicLink() && (profile.mode & 0o777) === 0o700;
  checks.push(
    observation(
      "session-metadata",
      privateProfile ? "passed" : profile ? "failed" : "blocked",
      privateProfile ? "PROFILE_PRIVATE" : "PROFILE_UNAVAILABLE_OR_UNSAFE",
      "Only profile directory metadata inspected; sign-in validity is unrun.",
      privateProfile
        ? null
        : "Owner: review profile location/permissions; first login remains Owner-only.",
    ),
  );
  checks.push(
    observation(
      "session-validity",
      "unrun",
      "SESSION_NOT_OPENED",
      "No browser/session read occurred.",
      "Owner: npm run login when an authorized live read requires it.",
    ),
  );
  const mount = config.driveMountPath ? await metadata(config.driveMountPath, inspect) : null;
  checks.push(
    observation(
      "drive",
      mount?.isDirectory() ? "passed" : "blocked",
      mount?.isDirectory() ? "DRIVE_PRESENT" : "DRIVE_UNCONFIRMED",
      "Configured Drive directory presence only; no remote sync claim.",
      mount?.isDirectory()
        ? null
        : "Mount Drive and set driveMountPath before an Owner-approved sync.",
    ),
  );
  let reachable = 0;
  for (const course of config.courses) {
    const info = await metadata(course.destination, inspect);
    if (
      info?.isDirectory() &&
      (!config.driveMountPath ||
        (await insideCanonical(config.driveMountPath, course.destination, canonical)))
    )
      reachable += 1;
  }
  checks.push(
    observation(
      "destinations",
      reachable === config.courses.length ? "passed" : "blocked",
      reachable === config.courses.length ? "DESTINATIONS_PRESENT" : "DESTINATIONS_UNREACHABLE",
      "Destination directories checked without creating them.",
      reachable === config.courses.length
        ? null
        : "Owner: inspect destination availability/Drive containment before sync.",
      { configured: config.courses.length, reachable },
    ),
  );
  if (config.courses.some((course) => course.mediaMode !== "off")) {
    checks.push(...(await mediaHealth(config.media, { inspect, canonical, space, read })));
  } else {
    checks.push(
      observation("media-runtime", "unrun", "MEDIA_OFF", "All courses exclude media processing."),
    );
  }
  return capabilityResult("health", checks, {
    scope: "local-filesystem-observations",
    upstreamCompleteness: "unrun",
    runtimeExecution: "unrun",
    runtimeChecksums: "unrun",
  });
}

async function mediaHealth(media, { inspect, canonical, space, read }) {
  const safeRoot = await insideCanonical("/Volumes/RAID0", media.mediaRoot, canonical);
  if (!safeRoot)
    return [
      observation(
        "media-store",
        "failed",
        "MEDIA_STORE_UNAVAILABLE",
        "Media store must resolve inside RAID0.",
        "Mount RAID0; Owner reviews media.mediaRoot before setup.",
      ),
    ];
  let freeBytes;
  try {
    const stats = await space(media.mediaRoot);
    freeBytes = Number(stats.bavail) * Number(stats.bsize || stats.frsize);
  } catch {
    return [
      observation(
        "media-space",
        "blocked",
        "MEDIA_SPACE_UNAVAILABLE",
        "Free space could not be observed.",
        "Mount RAID0 before an Owner-approved media action.",
      ),
    ];
  }
  const sufficient = Number.isSafeInteger(freeBytes) && freeBytes >= media.freeSpaceReserveBytes;
  const checks = [
    observation(
      "media-space",
      sufficient ? "passed" : "failed",
      sufficient ? "MEDIA_RESERVE_PRESENT" : "MEDIA_RESERVE_LOW",
      "Observed free space compared with the configured reserve.",
      sufficient ? null : "Owner: inspect disk usage; no cleanup or reserve change performed.",
      { freeBytes, reserveBytes: media.freeSpaceReserveBytes },
    ),
  ];
  const runtime = mediaRuntimePaths(media.mediaRoot);
  const manifest = await read(runtime.manifest);
  let valid =
    manifest.status === "passed" &&
    manifest.value?.version === 1 &&
    Array.isArray(manifest.value.artifacts) &&
    manifest.value.artifacts.length === 5;
  if (valid) {
    const keys = new Set();
    for (const artifact of manifest.value.artifacts) {
      if (
        typeof artifact?.path !== "string" ||
        isAbsolute(artifact.path) ||
        artifact.path.split(/[\\/]/).includes("..") ||
        keys.has(artifact.key)
      ) {
        valid = false;
        break;
      }
      keys.add(artifact.key);
      const info = await metadata(join(runtime.root, artifact.path), inspect);
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.size !== artifact.bytes ||
        !(await insideCanonical(runtime.root, join(runtime.root, artifact.path), canonical))
      )
        valid = false;
    }
  }
  checks.push(
    observation(
      "media-runtime-metadata",
      valid ? "passed" : manifest.status === "blocked" ? "blocked" : "failed",
      valid ? "RUNTIME_METADATA_PRESENT" : "RUNTIME_METADATA_INVALID",
      "Manifest and artifact metadata only; production still verifies pins, hashes and tools.",
      valid
        ? null
        : "Owner: review setup configuration; npm run media:setup requires explicit approval.",
    ),
  );
  return checks;
}

async function metadata(path, inspect) {
  try {
    return await inspect(path);
  } catch {
    return null;
  }
}

async function insideCanonical(root, target, canonical) {
  try {
    const child = relative(await canonical(root), await canonical(target));
    return (
      child === "" ||
      (!isAbsolute(child) &&
        child !== ".." &&
        !child.startsWith("../") &&
        !child.startsWith("..\\"))
    );
  } catch {
    return false;
  }
}

function supportedNode(value = "") {
  const [major, minor] = value.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 13);
}
