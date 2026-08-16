import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { assertMediaRoot } from "./paths.mjs";
import { writeAtomically } from "../sync/files.mjs";

// eslint-disable-next-line no-control-regex -- control characters cannot be filenames
const UNSAFE_FILENAME_CHARACTERS = /[\\/:*?"<>|\x00-\x1F]/g;

// Source evidence is keyed by the appearance, while only the visible derivatives follow the
// content-tree placement. This keeps a provider transcript reconstructible without putting it in
// the course destination.
export function createMediaStorage({ mediaRoot, volumeRoot, write = writeAtomically }) {
  const root = assertMediaRoot(mediaRoot, volumeRoot);

  return {
    async write({ appearance, kind, mediaKind, content, filename }) {
      const target = targetFor({ root, appearance, kind, mediaKind, filename });
      if (target.existing) return { path: target.path, status: "existing" };
      await mkdir(resolve(target.path, ".."), { recursive: true });
      await write(target.path, content);
      return { path: target.path, status: "written" };
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
  if (kind === "media") {
    if (appearance.placement.videoAlreadyPresent) {
      return { path: visiblePath(appearance, appearance.placement.videoPath), existing: true };
    }
    if (appearance.storageSurface === "media-store") {
      return { path: join(recordingRoot, "media", safeFilename(filename, `${mediaKind}.bin`)) };
    }
    return { path: visiblePath(appearance, appearance.placement.videoPath) };
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
  const name = basename(String(value ?? ""));
  const extension = extname(name);
  const stem = name
    .slice(0, extension ? -extension.length : undefined)
    .replace(UNSAFE_FILENAME_CHARACTERS, "_")
    .trim();
  return `${stem || fallback}${extension.replace(UNSAFE_FILENAME_CHARACTERS, "_")}`;
}
