import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const MEDIA_VOLUME_ROOT = "/Volumes/RAID0";
export const MEDIA_MODES = Object.freeze(["active", "pilot", "off"]);
export const DEFAULT_MEDIA_FREE_SPACE_RESERVE_BYTES = 100 * 1024 ** 3;

export function mediaRuntimePaths(mediaRoot) {
  const root = resolve(mediaRoot, ".runtime");
  const paths = {
    root,
    bin: join(root, "bin"),
    models: join(root, "models"),
    cache: join(root, "cache"),
    temp: join(root, "tmp"),
    work: join(root, "work"),
    metadata: join(root, "metadata"),
  };
  return {
    ...paths,
    manifest: join(paths.metadata, "runtime.json"),
  };
}

export function artifactPath(runtime, kind, filename) {
  const directory = kind === "runtime" ? runtime.bin : runtime.models;
  const target = resolve(directory, filename);
  assertInside(runtime.root, target, `${kind} artifact`);
  return target;
}

export function assertMediaRoot(mediaRoot, volumeRoot = MEDIA_VOLUME_ROOT) {
  if (typeof mediaRoot !== "string" || !isAbsolute(mediaRoot)) {
    throw new Error("media.mediaRoot must be an absolute path on the RAID0 volume.");
  }
  const resolvedRoot = resolve(mediaRoot);
  const resolvedVolume = resolve(volumeRoot);
  if (!isInside(resolvedVolume, resolvedRoot)) {
    throw new Error(`media.mediaRoot must be a directory below ${resolvedVolume}.`);
  }
  if (resolvedRoot === resolvedVolume) {
    throw new Error(
      "media.mediaRoot must be a directory inside /Volumes/RAID0, not the volume root.",
    );
  }
  return resolvedRoot;
}

export function assertInside(root, path, label) {
  const relativePath = relative(resolve(root), resolve(path));
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  ) {
    return path;
  }
  throw new Error(`${label} resolves outside the media runtime area.`);
}

export function assertFilename(filename, label) {
  if (
    typeof filename !== "string" ||
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw new Error(`${label} filename must be one file name, not a path.`);
  }
  return filename;
}

function isInside(root, path) {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}
