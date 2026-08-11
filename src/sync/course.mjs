import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { externalLinkOf, isFolder } from "../ntulearn/content.mjs";
import { expectedAttachments } from "./attachments.mjs";
import { isFilePresent, writeAtomically, writeIfChanged } from "./files.mjs";
import {
  announcementDocument,
  contentDocument,
  courseDocument,
  isoDate,
  uncopiedDocument,
} from "./markdown.mjs";
import { orderedName, safeResolve, safeSegment } from "./paths.mjs";
import { placementsIn } from "./placement.mjs";
import { courseState, newIds } from "./state.mjs";

const COURSE_DOCUMENT = "Course.md";
const FOLDER_DOCUMENT = "_NTULearn.md";
const ANNOUNCEMENTS_FOLDER = "Announcements";

// Additive: a run that finds less than the last one leaves the earlier files alone (ADR-0003).
export async function syncCourse({ client, course, state }) {
  const snapshot = await client.readCourse(course.courseId);
  const previous = courseState(state, course.key);
  const tally = { downloaded: 0, skipped: 0, bytes: 0, markdown: 0, uncopied: 0, failures: [] };
  const downloads = {};

  await mkdir(course.destination, { recursive: true });
  const overview = safeResolve(course.destination, COURSE_DOCUMENT);
  await writeDocument(overview, courseDocument(snapshot.course), tally);

  const placements = placementsIn(snapshot.items);
  // An item that wrote no page, until an attachment below claims it. Whatever is still here
  // afterwards would leave the destination holding nothing for it at all (ADR-0006).
  const unwritten = new Map();

  for (const item of snapshot.items) {
    // A folder's own placement is the folder it makes; anything else's is the folder it lands in.
    const folder = safeResolve(course.destination, ...placements.get(item.id).segments);

    if (isFolder(item)) {
      await mkdir(folder, { recursive: true });
      await writeDocument(safeResolve(folder, FOLDER_DOCUMENT), contentDocument(item), tally);
      continue;
    }

    const page = contentDocument(item, externalLinkOf(item));
    const target = safeResolve(folder, `${orderedName(item.position, item.title)}.md`);
    if (page) await writeDocument(target, page, tally);
    else unwritten.set(item.id, { item, target });
  }

  for await (const { item, attachment, placement } of expectedAttachments({
    client,
    courseId: course.courseId,
    items: snapshot.items,
  })) {
    // Its file is the trace, and a download that fails leaves a failure naming where it belonged.
    unwritten.delete(item.id);
    const record = previous.downloads?.[attachment.resourceUrl];
    const saved = await saveAttachment({
      course,
      client,
      placement,
      item,
      attachment,
      record,
      tally,
    });
    if (saved) downloads[attachment.resourceUrl] = saved;
  }

  for (const { item, target } of unwritten.values()) {
    tally.uncopied += 1;
    // An item hidden by a release rule reads exactly like one there was never anything to copy
    // from, so a page the student already has is never replaced by the statement that there is
    // nothing to copy — additive in the direction ADR-0003 argues for.
    if (await isFilePresent(target)) continue;
    await writeDocument(target, uncopiedDocument(item, placements.get(item.id).trail), tally);
  }

  await writeAnnouncements(course.destination, snapshot.announcements, tally);

  const current = {
    courseId: course.courseId,
    destination: course.destination,
    syncedAt: new Date().toISOString(),
    downloads,
    contentIds: snapshot.items.map((item) => item.id),
    announcementIds: snapshot.announcements.map((announcement) => announcement.id),
    conversationIds: snapshot.conversations.map((conversation) => conversation.id),
  };
  state.courses[course.key] = current;

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    contentItems: current.contentIds.length,
    announcements: current.announcementIds.length,
    conversations: current.conversationIds.length,
    newContent: newIds(current.contentIds, previous.contentIds).length,
    newAnnouncements: newIds(current.announcementIds, previous.announcementIds).length,
    newConversations: newIds(current.conversationIds, previous.conversationIds).length,
    ...tally,
  };
}

async function saveAttachment({ client, course, placement, item, attachment, record, tally }) {
  const target = safeResolve(course.destination, ...placement.segments);
  const fingerprint = attachmentFingerprint(item, attachment);

  const unchanged =
    record?.fingerprint === fingerprint &&
    record.relativePath === placement.path &&
    (await isFilePresent(target, attachment.fileSize));
  if (unchanged) {
    tally.skipped += 1;
    return record;
  }

  try {
    const { body, headers } = await client.download(attachment.resourceUrl);
    await writeAtomically(target, body);
    tally.downloaded += 1;
    tally.bytes += body.length;
    return {
      fingerprint,
      relativePath: placement.path,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      mimeType: attachment.mimeType || headers["content-type"] || null,
    };
  } catch (error) {
    // Where it was and where it would have gone, because the item's own title is `ultraDocumentBody`
    // for every embedded document in a course and so names nothing (#21).
    tally.failures.push({
      file: placement.file,
      trail: placement.trail,
      path: placement.path,
      error: error.message,
    });
    // No record, so the next run treats this attachment as never downloaded and tries again.
    return null;
  }
}

async function writeAnnouncements(destination, announcements, tally) {
  if (!announcements.length) return;
  const folder = safeResolve(destination, ANNOUNCEMENTS_FOLDER);
  await mkdir(folder, { recursive: true });
  for (const announcement of announcements) {
    const date = datePrefix(announcement.createdDate || announcement.modifiedDate);
    const name = `${date} ${safeSegment(announcement.title)}.md`;
    await writeDocument(safeResolve(folder, name), announcementDocument(announcement), tally);
  }
}

function attachmentFingerprint(item, attachment) {
  return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
}

async function writeDocument(path, content, tally) {
  if (!content) return;
  await writeIfChanged(path, content);
  tally.markdown += 1;
}

function datePrefix(value) {
  return isoDate(value)?.slice(0, 10) ?? "undated";
}
