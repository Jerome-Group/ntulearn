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

// The folders an item is in, itself included when it is one — so a folder's own document and the
// files beneath it are named by the same walk rather than by two expressions that agree today.
//
// The trail is those folders in NTULearn's own words, so a person can find the place in the
// browser; the segments are the same folders as the destination numbers and sanitises them.
function placementOf(item, itemsById) {
  const folders = [];
  for (let each = item; each; each = itemsById.get(each.parentId)) {
    if (isFolder(each)) folders.unshift(each);
  }
  return {
    trail: folders.map((folder) => folder.title).join(TRAIL_SEPARATOR),
    segments: folders.map((folder) => orderedName(folder.position, folder.title)),
  };
}
