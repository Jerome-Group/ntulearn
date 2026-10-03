import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { historicalReads, HISTORICAL_LIMITS } from "./historical-files.mjs";
import { parseCatalogueMetadata } from "./catalogue-safety.mjs";

export const CATALOGUE_POLICY = "verified-reading-v1";
export const catalogueFailure = (code = "CATALOGUE_EVIDENCE_INVALID") =>
  Object.assign(
    new Error(
      "Inspect private catalogue evidence and retry an unchanged plan; originals and user edits remain.",
    ),
    { code },
  );
export function catalogueReads(signal) {
  const reads = historicalReads({
    signal,
    limits: { ...HISTORICAL_LIMITS, fileBytes: 16 * 1024 ** 2 },
  });
  const files = new Map(),
    absences = new Map();
  return {
    ...reads,
    files,
    absences,
    async file(path) {
      const file = await reads.read(path);
      const prior = files.get(path);
      if (prior && prior.sha256 !== file.sha256) throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
      files.set(path, file);
      return file;
    },
    async optional(path) {
      try {
        return await this.file(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
    },
  };
}
export function catalogueJson(file) {
  return parseCatalogueMetadata(file.content);
}
export const catalogueFingerprint = ({ path, sha256, bytes }) => ({ path, sha256, bytes });

export async function scanCatalogue(root, reads) {
  const paths = [];
  let entries = 0;
  async function walk(directory, depth) {
    if (depth > HISTORICAL_LIMITS.depth) throw catalogueFailure("CATALOGUE_LIMIT");
    for (const name of (await reads.probe(() => readdir(directory))).sort()) {
      if (++entries > HISTORICAL_LIMITS.files) throw catalogueFailure("CATALOGUE_LIMIT");
      if (name === ".runtime" || name === ".catalogue-history") continue;
      const path = join(directory, name),
        info = await reads.probe(() => lstat(path));
      if (info.isSymbolicLink()) throw catalogueFailure("CATALOGUE_PATH_UNSAFE");
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (!info.isFile()) throw catalogueFailure("CATALOGUE_PATH_UNSAFE");
      else if (
        /transcript\.(?:raw|metadata|state)\.json$|\.transcript\.md$|\.recovered-[0-9a-f]{32}\.md(?:\.(?:source|native-asr|provenance)\.json)?$|^recovery\.json$/i.test(
          name,
        ) ||
        (directory.split(sep).includes("Transcript editions") &&
          /recording-[0-9a-f]{24}\.md(?:\.(?:provenance|receipt)\.json)?$/.test(name)) ||
        directory.split(sep).includes("provider")
      )
        paths.push(path);
    }
  }
  if ((await reads.probe(() => realpath(root))) !== root)
    throw catalogueFailure("CATALOGUE_PATH_UNSAFE");
  await walk(root, 0);
  return paths;
}
