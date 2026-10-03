import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { insideHistoricalRoot } from "./historical-files.mjs";
import { catalogueFailure } from "./catalogue-files.mjs";

// Metadata only: an absent leaf still belongs to its physical existing ancestor.
export async function catalogueProfileBinding(profilePath) {
  if (!profilePath) return null;
  const logical = resolve(profilePath);
  let ancestor = logical;
  while (true) {
    try {
      const canonical = await realpath(ancestor),
        info = await lstat(canonical);
      return {
        logical,
        ancestor,
        canonical,
        dev: info.dev,
        ino: info.ino,
        physical: resolve(canonical, relative(ancestor, logical)),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink())
          throw catalogueFailure("CATALOGUE_PROFILE_BOUNDARY");
      } catch (metadataError) {
        if (metadataError.code !== "ENOENT") throw metadataError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw catalogueFailure("CATALOGUE_PROFILE_BOUNDARY");
      ancestor = parent;
    }
  }
}
export async function assertCatalogueProfile(binding, roots) {
  if (!binding) return;
  const current = await catalogueProfileBinding(binding.logical);
  if (JSON.stringify(current) !== JSON.stringify(binding))
    throw catalogueFailure("CATALOGUE_PROFILE_BOUNDARY");
  for (const root of roots) {
    const canonical = await realpath(root);
    if (
      canonical === binding.physical ||
      insideHistoricalRoot(canonical, binding.physical) ||
      insideHistoricalRoot(binding.physical, canonical)
    )
      throw catalogueFailure("CATALOGUE_PROFILE_BOUNDARY");
  }
}

export async function assertCataloguePrivatePath(binding, path) {
  if (!binding) return;
  await assertCatalogueProfile(binding, []);
  const target = await catalogueProfileBinding(path);
  for (const root of [binding.logical, binding.physical])
    for (const candidate of [target.logical, target.physical])
      if (candidate === root || insideHistoricalRoot(root, candidate))
        throw catalogueFailure("CATALOGUE_PROFILE_BOUNDARY");
}
