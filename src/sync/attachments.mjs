import { isFolder } from "../ntulearn/content.mjs";
import { attachmentPlacement, placementsIn } from "./placement.mjs";

// Every attachment a course is expected to hold, and where each one belongs. A sync downloads what
// this yields and `verify` looks for it, so neither can expect a file the other has never heard of
// — which is the drift a shared placement alone does not prevent (ADR-0005).
//
// A folder is passed over: it holds children rather than files, so an embed in its own body is a
// link on the page written for it and no run downloads it.
export async function* expectedAttachments({ client, courseId, items }) {
  const placements = placementsIn(items);

  for (const item of items) {
    if (isFolder(item)) continue;
    for (const attachment of await client.readAttachments(courseId, item)) {
      const placement = attachmentPlacement(placements.get(item.id), item, attachment);
      yield { item, attachment, placement };
    }
  }
}
