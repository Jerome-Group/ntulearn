import { Buffer } from "node:buffer";
import { lstat, realpath, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createCatalogueMediaReads, CATALOGUE_MEDIA_LIMITS } from "./catalogue-media-read.mjs";
import {
  catalogueProfileBinding,
  assertCatalogueProfile,
  assertCataloguePrivatePath,
} from "./catalogue-profile.mjs";
import { HISTORICAL_LIMITS, publishHistoricalFile, historicalDigest } from "./historical-files.mjs";
import { closeMediaProbeHandle } from "./probe-settlement.mjs";

export const unassociatedFailure = (code = "UNASSOCIATED_FORMAT_EVIDENCE_INVALID") =>
  Object.assign(
    new Error(
      "Inspect private standalone evidence and retained source; retry a fresh plan without replacing originals or user edits.",
    ),
    { code },
  );

export async function unassociatedFiles(config, signal, dependencies = {}) {
  const io = createCatalogueMediaReads(signal, {
    ...dependencies,
    limits: {
      ...CATALOGUE_MEDIA_LIMITS,
      fileBytes: HISTORICAL_LIMITS.fileBytes,
      totalBytes: HISTORICAL_LIMITS.totalBytes,
      fileTimeoutMs: 5000,
      ...dependencies.limits,
    },
  });
  if (
    typeof config.media.mediaRoot !== "string" ||
    config.media.mediaRoot.includes("\0") ||
    config.media.mediaRoot.split(sep).includes(".runtime")
  )
    throw unassociatedFailure();
  const profile = await io.probe(() => catalogueProfileBinding(config.profilePath));
  if (
    typeof config.statePath !== "string" ||
    resolve(config.statePath) !== config.statePath ||
    config.statePath.split(sep).includes(".runtime")
  )
    throw unassociatedFailure();
  await io.probe(() => assertCataloguePrivatePath(profile, config.statePath));
  const stateParent = dirname(config.statePath);
  if ((await io.probe(() => realpath(stateParent))) !== stateParent) throw unassociatedFailure();
  const root = await io.probe(() => realpath(config.media.mediaRoot));
  const binding = await io.probe(() => catalogueProfileBinding(config.media.mediaRoot));
  await io.probe(() => assertCatalogueProfile(profile, [root]));
  const rootInfo = await io.probe(() => lstat(root));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unassociatedFailure();
  const rootPin = { path: root, dev: rootInfo.dev, ino: rootInfo.ino };
  async function assertRoot() {
    await io.probe(() => assertCatalogueProfile(profile, [root]));
    if (
      JSON.stringify(await io.probe(() => catalogueProfileBinding(config.media.mediaRoot))) !==
      JSON.stringify(binding)
    )
      throw unassociatedFailure();
    await io.assertParents({ parents: [rootPin] });
  }
  const controlNames = new Set([
    "media-safety.json",
    "media-queue",
    "media-queue.lock",
    "media-lock-admission.json",
    "watchdog.lock",
    "latest.json",
    "media-latest.json",
    "logs",
    "media-logs",
    "digests",
    "runs",
  ]);
  function controlPath(path) {
    return (
      path === config.statePath ||
      (path.startsWith(stateParent + sep) &&
        (basename(stateParent) === ".data" ||
          controlNames.has(path.slice(stateParent.length + 1).split(sep)[0])))
    );
  }
  async function permitted(path, { external = false } = {}) {
    if (resolve(path) !== path || path.includes("\0")) throw unassociatedFailure();
    if (
      path === config.statePath ||
      (external && controlPath(path)) ||
      (external && path.startsWith(root + sep)) ||
      path === root ||
      (!external && !path.startsWith(root + sep)) ||
      path.split(sep).includes(".runtime")
    )
      throw unassociatedFailure();
    await assertRoot();
    await io.probe(() => assertCataloguePrivatePath(profile, path));
    if (external && controlPath((await io.probe(() => catalogueProfileBinding(path))).physical))
      throw unassociatedFailure();
  }
  async function read(path, external = false) {
    await permitted(path, { external });
    return io.read(path, external ? dirname(path) : root, { retain: true });
  }
  async function absence(path) {
    await permitted(path);
    try {
      await io.probe(() => lstat(path));
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }
  let entries = 0;
  async function scan() {
    const paths = [];
    async function walk(path, depth) {
      if (depth > HISTORICAL_LIMITS.depth) throw unassociatedFailure("UNASSOCIATED_FORMAT_LIMIT");
      for (const name of (await io.probe(() => readdir(path))).sort()) {
        if (++entries > HISTORICAL_LIMITS.files)
          throw unassociatedFailure("UNASSOCIATED_FORMAT_LIMIT");
        if (name === ".runtime" || (path === root && name === "Unassociated")) continue;
        const child = join(path, name),
          info = await io.probe(() => lstat(child));
        if (info.isSymbolicLink()) throw unassociatedFailure();
        if (info.isDirectory()) await walk(child, depth + 1);
        else if (!info.isFile()) throw unassociatedFailure();
        else if (name === "transcript.raw.json") paths.push(child);
      }
    }
    await permitted(join(root, "recordings"));
    await walk(root, 0);
    return paths.sort();
  }
  async function publish(path, body, { external = false, checkCapacity, verifyInputs } = {}) {
    await permitted(path, { external });
    const content = Buffer.from(body);
    if (content.length > HISTORICAL_LIMITS.fileBytes)
      throw unassociatedFailure("UNASSOCIATED_FORMAT_LIMIT");
    return io.probe(async (combined) => {
      const reads = {
        active: () => {
          io.active();
          combined.throwIfAborted();
        },
        probe: (operation) => {
          combined.throwIfAborted();
          return io.probe(async () => operation());
        },
        read: (candidate) => {
          combined.throwIfAborted();
          return read(candidate, external);
        },
      };
      return publishHistoricalFile(path, content, {
        reads,
        boundary: external ? dirname(path) : root,
        checkCapacity,
        expectedSha256: historicalDigest(content),
        closeHandle: dependencies.closePublishedHandle ?? closeMediaProbeHandle,
        existingFile: async (candidate, expected, digest) => {
          let current;
          try {
            current = await read(candidate, external);
          } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
          }
          if (current.sha256 !== digest || !current.content.equals(expected))
            throw unassociatedFailure("UNASSOCIATED_FORMAT_OUTPUT_CHANGED");
          await io.assertIdentity(current);
          await verifyInputs?.();
          await io.assertParents(current);
          await io.assertIdentity(current);
          return true;
        },
      });
    });
  }
  return { root, rootPin, binding, io, read, absence, scan, publish, assertRoot, permitted };
}
