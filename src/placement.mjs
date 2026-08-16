import { attachmentName, isFolder } from "./ntulearn/content.mjs";
import { orderedName } from "./paths.mjs";

const TRAIL_SEPARATOR = " › ";

export function placementsIn(items) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return new Map(items.map((item) => [item.id, placementOf(item, itemsById)]));
}

export function attachmentPlacement(placement, item, attachment) {
  const file = attachmentName(item, attachment);
  return placedFile(placement, orderedName(item.position, file), file);
}

export function placedFile(placement, name, file = name) {
  const segments = [...placement.segments, name];
  return { file, trail: placement.trail, segments, path: segments.join("/") };
}

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
