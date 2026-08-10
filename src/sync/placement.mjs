import { attachmentName, isFolder } from "../ntulearn/content.mjs";
import { orderedName } from "./paths.mjs";

const TRAIL_SEPARATOR = " › ";

// Where a course's items land, and how to say where they came from. A sync writes to these places
// and `verify` reads them back, so both ask this rather than each walking the tree its own way.
export function placementsIn(items) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return new Map(items.map((item) => [item.id, placementOf(item, itemsById)]));
}

export function attachmentPlacement(placement, item, attachment) {
  const file = attachmentName(item, attachment);
  const segments = [...placement.segments, orderedName(item.position, file)];
  return { file, trail: placement.trail, segments, path: segments.join("/") };
}

// The trail is the folders in NTULearn's own words, so a person can find the place in the browser;
// the segments are the same folders as the destination numbers and sanitises them.
function placementOf(item, itemsById) {
  const folders = [];
  for (let parent = itemsById.get(item.parentId); parent; parent = itemsById.get(parent.parentId)) {
    if (isFolder(parent)) folders.unshift(parent);
  }
  return {
    trail: folders.map((folder) => folder.title).join(TRAIL_SEPARATOR),
    segments: folders.map((folder) => orderedName(folder.position, folder.title)),
  };
}
