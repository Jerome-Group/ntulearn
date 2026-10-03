import { dirname, join } from "node:path";
import { historicalDigest } from "./historical-files.mjs";
import {
  inspectHistoricalSource,
  historicalParagraphs,
  HISTORICAL_FORMAT_VERSION,
} from "./historical-format.mjs";
import { parseCatalogueMetadata, CATALOGUE_METADATA_LIMITS } from "./catalogue-safety.mjs";
import { unassociatedFailure } from "./unassociated-files.mjs";

export const UNASSOCIATED_POLICY = "unassociated-review-paragraphs-v1";
export async function unassociatedInventory(files) {
  const sources = [],
    excluded = [];
  for (const path of await files.scan()) {
    const metadataPath = join(dirname(path), "transcript.metadata.json");
    if (!(await files.absence(metadataPath))) {
      excluded.push({ path, reason: "metadata-present-use-course-route" });
      continue;
    }
    const pin = await files.read(path);
    try {
      parseCatalogueMetadata(pin.content, {
        limits: { ...CATALOGUE_METADATA_LIMITS, bytes: 4 * 1024 ** 2, stringBytes: 4 * 1024 ** 2 },
      });
    } catch (error) {
      if (error.code !== "CATALOGUE_METADATA_INVALID") throw error;
    }
    const inspected = inspectHistoricalSource(pin.content);
    const eligible = inspected.valid && inspected.eligible === true;
    const source = {
      id: historicalDigest(JSON.stringify({ path, sha256: pin.sha256 })).slice(0, 32),
      pin: { ...pin, content: undefined },
      metadataPath,
      metadataAbsent: true,
      valid: inspected.valid,
      eligible,
      sourceFlags: inspected.flags,
      timing: inspected.timing,
      association: "unverified-by-this-edition",
      reading: "review-only",
      complete: false,
    };
    if (eligible) source.markdown = historicalParagraphs(inspected.source);
    sources.push(source);
  }
  const base = {
    schemaVersion: 1,
    policy: UNASSOCIATED_POLICY,
    formatter: HISTORICAL_FORMAT_VERSION,
    root: files.root,
    binding: files.binding,
    rootPin: files.rootPin,
    sources: sources.map(({ markdown: _markdown, ...source }) => source),
    excluded,
  };
  return { ...base, id: historicalDigest(JSON.stringify(base)).slice(0, 24), sources };
}
export function unassociatedManifest(inventory) {
  return {
    ...inventory,
    sources: inventory.sources.map(({ markdown: _markdown, ...source }) => source),
  };
}
export async function assertUnassociatedSnapshot(files, inventory, { hash = false } = {}) {
  await files.assertRoot();
  if (
    hash &&
    JSON.stringify(await files.scan()) !==
      JSON.stringify(
        [
          ...inventory.sources.map((s) => s.pin.path),
          ...inventory.excluded.map((s) => s.path),
        ].sort(),
      )
  )
    throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
  for (const source of inventory.sources) {
    await files.permitted(source.pin.path);
    if (!(await files.absence(source.metadataPath)))
      throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
    await files.io.assertIdentity(source.pin);
    if (hash && (await files.read(source.pin.path)).sha256 !== source.pin.sha256)
      throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
  }
  for (const source of inventory.excluded)
    if (await files.absence(join(dirname(source.path), "transcript.metadata.json")))
      throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
}
