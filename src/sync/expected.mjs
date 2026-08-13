import { externalLinkOf, isFolder } from "../ntulearn/content.mjs";
import {
  announcementDocument,
  contentDocument,
  courseDocument,
  isoDate,
  uncopiedDocument,
} from "./markdown.mjs";
import { orderedName, safeSegment } from "./paths.mjs";
import { attachmentPlacement, placedFile, placementsIn } from "./placement.mjs";

const COURSE_DOCUMENT = "Course.md";
const FOLDER_DOCUMENT = "_NTULearn.md";
const ANNOUNCEMENTS_FOLDER = "Announcements";

const DESTINATION_ROOT = { trail: "", segments: [] };
const ANNOUNCEMENTS = { trail: ANNOUNCEMENTS_FOLDER, segments: [ANNOUNCEMENTS_FOLDER] };

// Everything a course is expected to hold, and where each part of it belongs. A sync writes what
// this yields and `verify` looks for it, so neither can expect a file the other has never heard of
// — the drift a shared placement alone does not prevent (ADR-0005). Each document is yielded with
// the text a run would write, because a walk that only named the paths could still disagree with
// the one that produced the content.
export async function* expectedFiles({ client, courseId, snapshot }) {
  yield {
    kind: "document",
    placement: placedFile(DESTINATION_ROOT, COURSE_DOCUMENT),
    content: courseDocument(snapshot.course),
  };

  const placements = placementsIn(snapshot.items);
  for (const item of snapshot.items) {
    const placement = placements.get(item.id);
    if (isFolder(item)) yield* expectedOfFolder(item, placement);
    else yield* expectedOfItem({ client, courseId, item, placement });
  }

  for (const announcement of snapshot.announcements ?? []) {
    yield {
      kind: "document",
      placement: announcementPlacement(announcement),
      content: announcementDocument(announcement),
    };
  }
}

// A folder is a directory on disk whether or not it says anything, and the directory is its trace
// (ADR-0006). Its document is conditional, so what is expected of it has to be too — ADR-0005's
// amended second section is why.
function* expectedOfFolder(item, placement) {
  yield { kind: "folder", placement };

  const page = contentDocument(item);
  if (page) {
    yield { kind: "document", placement: placedFile(placement, FOLDER_DOCUMENT), content: page };
  }
}

async function* expectedOfItem({ client, courseId, item, placement }) {
  const page = contentDocument(item, externalLinkOf(item));
  const document = placedFile(
    placement,
    `${orderedName(item.position, item.title)}.md`,
    `${item.title}.md`,
  );
  if (page) yield { kind: "document", placement: document, content: page };

  let attached = false;
  for (const attachment of await client.readAttachments(courseId, item)) {
    attached = true;
    yield {
      kind: "attachment",
      item,
      attachment,
      placement: attachmentPlacement(placement, item, attachment),
    };
  }

  // The file an item carries is its own trace, so a document beside it would be a second one — and
  // an attachment that fails to download is the case `verify` is there for (ADR-0006). What is left
  // is an item the destination would otherwise hold nothing at all for.
  if (page || attached) return;
  yield {
    kind: "uncopied",
    placement: document,
    content: uncopiedDocument(item, placement.trail),
  };
}

function announcementPlacement(announcement) {
  const date = isoDate(announcement.createdDate || announcement.modifiedDate)?.slice(0, 10);
  return placedFile(
    ANNOUNCEMENTS,
    `${date ?? "undated"} ${safeSegment(announcement.title)}.md`,
    `${announcement.title}.md`,
  );
}
