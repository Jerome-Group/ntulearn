import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { markGlobalMediaSafety } from "./errors.mjs";
import { assertMediaRoot, MEDIA_VOLUME_ROOT } from "./paths.mjs";

// eslint-disable-next-line no-control-regex -- control characters cannot be filenames
const UNSAFE_FILENAME_CHARACTERS = /[\\/:*?"<>|\x00-\x1F]/g;

// Source evidence is keyed by the appearance, while only the visible derivatives follow the
// content-tree placement. This keeps a provider transcript reconstructible without putting it in
// the course destination.
export function createMediaStorage({
  mediaRoot,
  volumeRoot,
  write = writeAtomically,
  read = readFile,
  checkCapacity = null,
  capacityCheckTimeoutMs = 5_000,
}) {
  const root = assertMediaRoot(mediaRoot, volumeRoot);
  const probe = (inspect) =>
    checkCapacity
      ? withCapacityDeadline(inspect, { timeoutMs: capacityCheckTimeoutMs })
      : Promise.resolve().then(inspect);

  async function assertCurrentReplacement(path, proof) {
    const current = await probe(() => read(path)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw markGlobalMediaSafety(error);
    });
    if (!current || digest(current) !== proof.sha256) {
      throw new Error(
        "Formatted transcript replacement proof is stale or the derivative changed. Existing bytes retained; inspect ownership metadata before retrying regeneration.",
      );
    }
  }

  return {
    async write({
      appearance,
      kind,
      mediaKind,
      content,
      sourcePath,
      filename,
      replace,
      replaceProof = null,
    }) {
      if (replace !== undefined) {
        throw new Error("Replacement requires a proof-bearing formatted transcript request.");
      }
      if (content !== undefined && sourcePath !== undefined) {
        throw new Error("Media storage accepts content or sourcePath, not both.");
      }
      const target = targetFor({ root, appearance, kind, mediaKind, filename });
      await probe(() =>
        assertMediaArtifactPath(
          target.path,
          artifactRoot({ root: volumeRoot ?? MEDIA_VOLUME_ROOT, appearance, kind }),
        ),
      );
      if (replaceProof) {
        assertReplacementProof({ kind, target, replaceProof });
        await assertCurrentReplacement(target.path, replaceProof);
      }
      let alreadyPresent;
      try {
        alreadyPresent =
          !replaceProof && writeOnce(kind) && (await probe(() => isFilePresent(target.path)));
      } catch (error) {
        throw markGlobalMediaSafety(error);
      }
      if (alreadyPresent) {
        return { path: target.path, status: "existing" };
      }
      try {
        const boundary = artifactRoot({ root, appearance, kind });
        await probe(async () => {
          const bytes =
            sourcePath === undefined ? Buffer.byteLength(content) : (await stat(sourcePath)).size;
          await checkCapacity?.({ path: target.path, boundary, bytes });
        });
        await mkdir(dirname(target.path), { recursive: true });
        if (sourcePath !== undefined || checkCapacity || replaceProof || writeOnce(kind)) {
          await promoteAtomically({
            sourcePath,
            target: target.path,
            exclusive: writeOnce(kind) && !replaceProof,
            content,
            write,
            beforePromotion: async () => {
              await probe(async () => {
                await assertMediaArtifactPath(target.path, boundary);
                await checkCapacity?.({ path: target.path, boundary });
              });
              if (replaceProof) {
                await probe(() => assertMediaArtifactPath(target.path, boundary));
                await assertCurrentReplacement(target.path, replaceProof);
              }
            },
          });
        } else await write(target.path, content);
      } catch (error) {
        throw markGlobalMediaSafety(error);
      }
      return { path: target.path, status: "written" };
    },

    async read({ appearance, kind, mediaKind, filename }) {
      const target = targetFor({ root, appearance, kind, mediaKind, filename });
      await probe(() =>
        assertMediaArtifactPath(
          target.path,
          artifactRoot({ root: volumeRoot ?? MEDIA_VOLUME_ROOT, appearance, kind }),
        ),
      );
      try {
        return { path: target.path, content: await probe(() => read(target.path)) };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw markGlobalMediaSafety(error);
      }
    },
  };
}

async function promoteAtomically({
  sourcePath,
  target,
  exclusive,
  content,
  write,
  beforePromotion,
}) {
  const partial = `${target}.part-${randomUUID()}`;
  try {
    if (sourcePath !== undefined) await copyFile(sourcePath, partial);
    else await write(partial, content);
    await beforePromotion();
    if (exclusive) {
      try {
        await link(partial, target);
      } catch (cause) {
        throw Object.assign(
          new Error(
            cause.code === "EEXIST"
              ? "Media publication target became occupied. Existing bytes retained; inspect the target before retrying."
              : "Exclusive media publication failed. Retain existing files and retry on a filesystem supporting same-directory hard links.",
            { cause },
          ),
          { code: cause.code },
        );
      }
      await unlink(partial);
    } else await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

function targetFor({ root, appearance, kind, mediaKind, filename }) {
  const recordingRoot = mediaRecordingRoot(root, appearance.recordingId);
  if (kind === "provider-transcript") {
    return { path: join(recordingRoot, "provider", safeFilename(filename, "transcript.provider")) };
  }
  if (kind === "raw-transcript") return { path: join(recordingRoot, "transcript.raw.json") };
  if (kind === "metadata") return { path: join(recordingRoot, "transcript.metadata.json") };
  if (kind === "state") return { path: join(recordingRoot, "transcript.state.json") };
  if (kind === "media") {
    if (appearance.storageSurface === "media-gallery") {
      return {
        path: join(
          recordingRoot,
          "media",
          safeFilename(mediaFilename(appearance, mediaKind, filename), "recording"),
        ),
      };
    }
    const relativePath =
      mediaKind === "audio"
        ? (appearance.placement.audioPath ?? appearance.placement.videoPath)
        : appearance.placement.videoPath;
    return { path: visiblePath(appearance, relativePath) };
  }
  if (kind === "formatted-transcript") {
    return { path: visiblePath(appearance, appearance.placement.formattedTranscriptPath) };
  }
  if (kind === "status") return { path: visiblePath(appearance, appearance.placement.statusPath) };
  throw new Error(`Unknown media artifact: ${kind}`);
}

function mediaFilename(appearance, mediaKind, filename) {
  if (filename) return filename;
  return mediaKind === "audio"
    ? basename(appearance.placement.audioPath ?? "recording.m4a")
    : basename(appearance.placement.videoPath ?? "recording.mp4");
}

function visiblePath(appearance, relativePath) {
  const destination = resolve(appearance.placement.destination);
  const segments = String(relativePath ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => safeFilename(segment, "untitled"));
  const target = resolve(destination, ...segments);
  if (target === destination || !target.startsWith(`${destination}${sep}`)) {
    throw new Error(`Unsafe media destination path: ${relativePath}`);
  }
  return target;
}

export function mediaRecordingRoot(mediaRoot, recordingId) {
  return join(mediaRoot, "recordings", recordingKey(recordingId));
}

function recordingKey(recordingId) {
  return createHash("sha256").update(String(recordingId)).digest("hex").slice(0, 24);
}

function safeFilename(value, fallback) {
  const raw = String(value ?? "");
  let path;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0];
  }
  const name = basename(path);
  const extension = extname(name);
  const stem = name
    .slice(0, extension ? -extension.length : undefined)
    .replace(UNSAFE_FILENAME_CHARACTERS, "_")
    .trim();
  return `${stem || fallback}${extension.replace(UNSAFE_FILENAME_CHARACTERS, "_")}`;
}

async function isFilePresent(path) {
  const info = await stat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(info?.isFile());
}

function writeOnce(kind) {
  return ["provider-transcript", "raw-transcript", "formatted-transcript", "media"].includes(kind);
}

function assertReplacementProof({ kind, target, replaceProof }) {
  if (
    kind !== "formatted-transcript" ||
    replaceProof.path !== target.path ||
    !/^[0-9a-f]{64}$/.test(replaceProof.sha256) ||
    !/^[0-9a-f]{64}$/.test(replaceProof.sourceSha256)
  ) {
    throw new Error("Only a current formatted transcript may be replaced.");
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactRoot({ root, appearance, kind }) {
  const visible =
    kind === "formatted-transcript" ||
    kind === "status" ||
    (kind === "media" && appearance.storageSurface !== "media-gallery");
  return visible ? resolve(appearance.placement.destination) : root;
}

export async function assertMediaArtifactPath(path, root) {
  const target = resolve(path);
  const boundary = resolve(root);
  if (target === boundary || !target.startsWith(`${boundary}${sep}`)) {
    throw markGlobalMediaSafety(new Error("Media artifact resolves outside its storage root."));
  }
  let current = target;
  while (true) {
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw markGlobalMediaSafety(error);
    });
    if (info?.isSymbolicLink()) {
      throw markGlobalMediaSafety(
        new Error(
          `Media artifact path is a symlink: ${current}. Keep artifacts inside their course or Media store.`,
        ),
      );
    }
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
