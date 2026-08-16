import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { assertMediaRoot } from "./paths.mjs";

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
}) {
  const root = assertMediaRoot(mediaRoot, volumeRoot);

  return {
    async write({ appearance, kind, mediaKind, content, filename, replace, replaceProof = null }) {
      if (replace !== undefined) {
        throw new Error("Replacement requires a proof-bearing formatted transcript request.");
      }
      const target = targetFor({ root, appearance, kind, mediaKind, filename });
      if (replaceProof) {
        assertReplacementProof({ kind, target, replaceProof });
        const current = await read(target.path).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!current || digest(current) !== replaceProof.sha256) {
          throw new Error("Formatted transcript replacement proof is stale.");
        }
      }
      if (!replaceProof && writeOnce(kind) && (await isFilePresent(target.path))) {
        return { path: target.path, status: "existing" };
      }
      await mkdir(dirname(target.path), { recursive: true });
      await write(target.path, content);
      return { path: target.path, status: "written" };
    },

    async read({ appearance, kind, mediaKind, filename }) {
      const target = targetFor({ root, appearance, kind, mediaKind, filename });
      try {
        return { path: target.path, content: await read(target.path) };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function targetFor({ root, appearance, kind, mediaKind, filename }) {
  const recordingRoot = join(root, "recordings", recordingKey(appearance.recordingId));
  if (kind === "provider-transcript") {
    return { path: join(recordingRoot, "provider", safeFilename(filename, "transcript.provider")) };
  }
  if (kind === "raw-transcript") return { path: join(recordingRoot, "transcript.raw.json") };
  if (kind === "metadata") return { path: join(recordingRoot, "transcript.metadata.json") };
  if (kind === "state") return { path: join(recordingRoot, "transcript.state.json") };
  if (kind === "media") {
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

// Media writes are atomic without depending on the sync layer. A partial file must never become a
// visible course artifact if the process is interrupted between download and rename.
async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part-${process.pid}`;
  try {
    await writeFile(partial, content);
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}
