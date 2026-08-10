import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import {
  attachmentName,
  attachmentsOf,
  externalLinkOf,
  isFile,
  isFolder,
} from "../ntulearn/content.mjs";
import { isFileOfSize, writeAtomically, writeIfChanged } from "./files.mjs";
import { announcementDocument, contentDocument, courseDocument, isoDate } from "./markdown.mjs";
import { orderedName, safeResolve, safeSegment } from "./paths.mjs";
import { courseState, newIds } from "./state.mjs";

const COURSE_DOCUMENT = "Course.md";
const FOLDER_DOCUMENT = "_NTULearn.md";
const ANNOUNCEMENTS_FOLDER = "Announcements";

// Additive: a run that finds less than the last one leaves the earlier files alone (ADR-0003).
export async function syncCourse({ client, course, state }) {
  const snapshot = await client.readCourse(course.courseId);
  const previous = courseState(state, course.key);
  const tally = { downloaded: 0, skipped: 0, bytes: 0, markdown: 0, failures: [] };
  const downloads = {};

  await mkdir(course.destination, { recursive: true });
  const overview = safeResolve(course.destination, COURSE_DOCUMENT);
  await writeDocument(overview, courseDocument(snapshot.course), tally);

  const itemsById = new Map(snapshot.items.map((item) => [item.id, item]));
  for (const item of snapshot.items) {
    const folder = safeResolve(course.destination, ...ancestorFolders(item, itemsById));

    if (isFolder(item)) {
      const own = safeResolve(folder, orderedName(item.position, item.title));
      await mkdir(own, { recursive: true });
      await writeDocument(safeResolve(own, FOLDER_DOCUMENT), contentDocument(item), tally);
      continue;
    }

    const page = contentDocument(item, externalLinkOf(item));
    const target = safeResolve(folder, `${orderedName(item.position, item.title)}.md`);
    await writeDocument(target, page, tally);

    for (const attachment of await attachmentsWithDetail(client, course.courseId, item)) {
      const record = previous.downloads?.[attachment.resourceUrl];
      const saved = await saveAttachment({
        course,
        client,
        folder,
        item,
        attachment,
        record,
        tally,
      });
      if (saved) downloads[attachment.resourceUrl] = saved;
    }
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

async function saveAttachment({ client, course, folder, item, attachment, record, tally }) {
  const target = safeResolve(folder, orderedName(item.position, attachmentName(item, attachment)));
  const relativePath = relative(course.destination, target);
  const fingerprint = attachmentFingerprint(item, attachment);

  const unchanged =
    record?.fingerprint === fingerprint &&
    record.relativePath === relativePath &&
    (await isFileOfSize(target, attachment.fileSize));
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
      relativePath,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      mimeType: attachment.mimeType || headers["content-type"] || null,
    };
  } catch (error) {
    tally.failures.push({
      item: item.title,
      file: attachmentName(item, attachment),
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

// The Summary view carries no attached file, so an item that claims one is re-read in full.
async function attachmentsWithDetail(client, courseId, item) {
  const attachments = attachmentsOf(item);
  if (attachments.length || !isFile(item)) return attachments;
  return attachmentsOf(await client.readContentItem(courseId, item.id));
}

function attachmentFingerprint(item, attachment) {
  return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
}

function ancestorFolders(item, itemsById) {
  const folders = [];
  for (let parent = itemsById.get(item.parentId); parent; parent = itemsById.get(parent.parentId)) {
    if (isFolder(parent)) folders.unshift(orderedName(parent.position, parent.title));
  }
  return folders;
}

async function writeDocument(path, content, tally) {
  if (!content) return;
  await writeIfChanged(path, content);
  tally.markdown += 1;
}

function datePrefix(value) {
  return isoDate(value)?.slice(0, 10) ?? "undated";
}
