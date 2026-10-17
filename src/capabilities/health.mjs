import { lstat, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { loadConfig } from "../config.mjs";
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
  checks.push(
    observation(
      "configuration",
      "passed",
      "CONFIG_VALID",
      "Configuration parsed; course contents and paths are excluded.",
      null,
      {
        courses: config.courses.length,
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
  return capabilityResult("health", checks, {
    scope: "local-filesystem-observations",
    upstreamCompleteness: "unrun",
  });
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
