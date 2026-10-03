import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { catalogueFailure } from "./catalogue-files.mjs";
import { assertCataloguePrivatePath, assertCatalogueProfile } from "./catalogue-profile.mjs";

export async function assertCatalogueBindings(bindings, { media, profileBinding }) {
  await media.probe(async () => {
    await assertCatalogueProfile(
      profileBinding,
      bindings.map((binding) => binding.logical),
    );
    for (const binding of bindings) {
      await assertCataloguePrivatePath(profileBinding, binding.logical);
      if ((await realpath(binding.logical)) !== binding.canonical)
        throw catalogueFailure("CATALOGUE_PARENT_CHANGED");
    }
  });
}

export async function catalogueCourseAliases({
  course,
  root,
  queue,
  boundary,
  reads,
  profileBinding,
}) {
  const aliases = new Map();
  for (const job of queue ?? []) {
    if (!job.placement) continue;
    const destination = job.placement.destination;
    // Only the current queue reader's positive physical course check grants an alias.
    const canonical =
      destination === course.destination ? root : boundary.placementKey(destination);
    const logical = resolve(destination);
    if (canonical !== root || logical.split(sep).includes(".runtime"))
      throw catalogueFailure("CATALOGUE_COURSE_BOUNDARY");
    aliases.set(logical, { logical, canonical });
  }
  const bindings = [...aliases.values()].sort((a, b) => a.logical.localeCompare(b.logical));
  await assertCatalogueBindings(bindings, { media: reads.media, profileBinding });
  return bindings;
}
