import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { artifactPath, assertMediaRoot, MEDIA_VOLUME_ROOT, mediaRuntimePaths } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_DIRECTORIES = ["root", "bin", "models", "cache", "temp", "work", "metadata"];

export async function setupMediaRuntime(media, options = {}) {
  if (!media) {
    throw new Error(
      "Media setup is not configured. Add media.mediaRoot and media.setup to config/courses.json.",
    );
  }
  if (!media.setup) {
    throw new Error(
      "Media setup is missing selected runtimes and models. Add media.setup to config/courses.json.",
    );
  }

  const fileSystem = options.fileSystem ?? defaultFileSystem();
  const volumeRoot = options.volumeRoot ?? MEDIA_VOLUME_ROOT;
  const mediaRoot = assertMediaRoot(media.mediaRoot, volumeRoot);
  const runtime = mediaRuntimePaths(mediaRoot);
  const artifacts = artifactSpecs(media.setup);
  await verifyMediaStore({
    mediaRoot,
    runtime,
    volumeRoot,
    reserve: media.freeSpaceReserveBytes,
    fileSystem,
    options,
  });
  await createRuntimeDirectories(runtime, fileSystem);

  const records = [];
  for (const artifact of artifacts) {
    records.push(await prepareArtifact({ artifact, runtime, fileSystem, options }));
  }

  const manifest = {
    version: 1,
    preparedAt: (options.now ?? (() => new Date()))().toISOString(),
    reserveBytes: media.freeSpaceReserveBytes,
    artifacts: records,
  };
  await writeAtomically(runtime.manifest, `${JSON.stringify(manifest, null, 2)}\n`, fileSystem);
  return { manifestPath: runtime.manifest, runtime, artifacts: records };
}

async function verifyMediaStore({ mediaRoot, runtime, volumeRoot, reserve, fileSystem, options }) {
  const rootInfo = await fileSystem.stat(mediaRoot).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new Error(
      `Media store is unavailable at ${mediaRoot}. Mount RAID0, then run: npm run media:setup`,
    );
  }

  const actualVolumeRoot = await fileSystem.realpath(resolve(volumeRoot)).catch(() => null);
  const actualMediaRoot = await fileSystem.realpath(mediaRoot).catch(() => null);
  if (!actualVolumeRoot || !actualMediaRoot || !isInside(actualVolumeRoot, actualMediaRoot)) {
    throw new Error(
      `Media store is not on RAID0: ${mediaRoot}. Choose a directory below ${volumeRoot}.`,
    );
  }
  await rejectSymlinkedRuntime(runtime, actualMediaRoot, fileSystem);

  const freeBytes = options.freeBytes ?? (await freeBytesOn(fileSystem, mediaRoot));
  if (freeBytes < reserve) {
    throw new Error(
      `Media store has ${formatBytes(freeBytes)} free but must keep ${formatBytes(reserve)} free. Free space or lower media.freeSpaceReserveBytes, then run: npm run media:setup`,
    );
  }
}

async function rejectSymlinkedRuntime(runtime, actualMediaRoot, fileSystem) {
  for (const key of RUNTIME_DIRECTORIES) {
    const path = runtime[key];
    const info = await fileSystem.lstat(path).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new Error(`Media runtime path is a symlink: ${path}. Move it inside the Media store.`);
    }
    const actualPath = await fileSystem.realpath(path);
    if (!isInside(actualMediaRoot, actualPath)) {
      throw new Error(`Media runtime path escapes the Media store: ${path}.`);
    }
  }
}

async function createRuntimeDirectories(runtime, fileSystem) {
  for (const key of RUNTIME_DIRECTORIES) {
    await fileSystem.mkdir(runtime[key], { recursive: true });
  }
}

function artifactSpecs(setup) {
  return [
    { key: "mediaTool", label: "media tool", ...setup.mediaTool },
    { key: "asr.runtime", label: "ASR runtime", ...setup.asr.runtime },
    { key: "asr.model", label: "ASR model", ...setup.asr.model },
    { key: "formatter.runtime", label: "formatter runtime", ...setup.formatter.runtime },
    { key: "formatter.model", label: "formatter model", ...setup.formatter.model },
  ];
}

async function prepareArtifact({ artifact, runtime, fileSystem, options }) {
  const target = artifactPath(runtime, artifact.kind, artifact.filename);
  const existingInfo = await fileSystem.lstat(target).catch(() => null);
  if (existingInfo?.isSymbolicLink()) {
    throw new Error(`Media artifact path is a symlink: ${target}. Move it inside the Media store.`);
  }
  if (existingInfo && !existingInfo.isFile()) {
    throw new Error(
      `Media artifact path is not a file: ${target}. Remove it, then run setup again.`,
    );
  }
  const existingDigest = await digestIfPresent(target, fileSystem);
  if (existingDigest !== artifact.sha256) {
    const temporary = `${runtime.temp}/${artifact.key.replaceAll(".", "-")}-${randomUUID()}.part`;
    try {
      await materialize(artifact, temporary, fileSystem, options);
      const digest = await digestFile(temporary);
      if (digest !== artifact.sha256) {
        throw new Error(`${artifact.label} checksum mismatch; check its pinned source and sha256.`);
      }
      if (artifact.kind === "runtime") await fileSystem.chmod(temporary, 0o755);
      await fileSystem.rename(temporary, target);
    } finally {
      await fileSystem.unlink(temporary).catch(() => {});
    }
  }

  if (artifact.kind === "runtime") await verifyRuntime(target, artifact, options);
  const info = await fileSystem.stat(target);
  return {
    key: artifact.key,
    identity: artifact.name,
    revision: artifact.revision,
    sha256: artifact.sha256,
    license: artifact.license,
    path: relative(runtime.root, target),
    bytes: info.size,
    sourceKind: artifact.source.kind,
  };
}

async function materialize(artifact, temporary, fileSystem, options) {
  if (artifact.source.kind === "file") {
    try {
      await fileSystem.copyFile(artifact.source.value, temporary);
    } catch (error) {
      throw new Error(
        `${artifact.label} source is unavailable; check media.setup.${artifact.key}.source.`,
        { cause: error },
      );
    }
    return;
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error(
      "Media setup cannot download artifacts because this Node runtime has no fetch.",
    );
  }
  const response = await fetcher(artifact.source.value);
  if (!response.ok) {
    throw new Error(`${artifact.label} download failed with HTTP ${response.status}.`);
  }
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  } else {
    await fileSystem.writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  }
}

async function verifyRuntime(path, artifact, options) {
  const result = await (options.commandRunner ?? runCommand)(path, artifact.verifyArgs);
  if (result.code !== 0) {
    throw new Error(
      `${artifact.label} did not pass ${artifact.verifyArgs.join(" ")} verification.`,
    );
  }
}

async function freeBytesOn(fileSystem, path) {
  const stats = await fileSystem.statfs(path);
  return Number(stats.bavail) * Number(stats.bsize || stats.frsize);
}

async function digestIfPresent(path, fileSystem) {
  const info = await fileSystem.stat(path).catch(() => null);
  return info?.isFile() ? digestFile(path) : null;
}

async function digestFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function writeAtomically(path, content, fileSystem) {
  const temporary = `${path}.part-${process.pid}`;
  try {
    await fileSystem.writeFile(temporary, content);
    await fileSystem.rename(temporary, path);
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function runCommand(command, argumentsFor) {
  try {
    await execFileAsync(command, argumentsFor, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { code: 0 };
  } catch (error) {
    return { code: error.code ?? 1 };
  }
}

function defaultFileSystem() {
  return {
    chmod,
    copyFile,
    lstat,
    mkdir,
    realpath,
    rename,
    stat,
    statfs,
    unlink,
    writeFile,
  };
}

function isInside(root, path) {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !child.startsWith(sep));
}

function formatBytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
