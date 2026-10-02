import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { MEDIA_VOLUME_ROOT, assertMediaRoot } from "./paths.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";

export async function evaluationOutputRoot(
  media,
  outputRoot = media.mediaRoot,
  { volumeRoot = MEDIA_VOLUME_ROOT } = {},
) {
  const root = assertMediaRoot(outputRoot, volumeRoot);
  await assertMediaArtifactPath(join(root, ".evaluation-probe"), resolve(volumeRoot));
  const [volume, destination, store, volumeInfo] = await Promise.all([
    realpath(volumeRoot),
    realpath(root),
    stat(media.mediaRoot),
    stat(volumeRoot),
  ]);
  const relation = relative(volume, destination);
  const info = await stat(root);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation.startsWith(sep) ||
    !info.isDirectory() ||
    info.dev !== store.dev ||
    store.dev !== volumeInfo.dev
  )
    throw new Error(
      "Evaluation output root is outside verified storage. Choose an explicitly authorized directory on the configured RAID0 device.",
    );
  return root;
}
