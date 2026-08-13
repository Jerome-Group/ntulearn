import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { downloadedType } from "../ntulearn/download.mjs";
import { expectedFiles } from "./expected.mjs";
import { isFilePresent, readText, writeAtomically, writeIfChanged } from "./files.mjs";
import { isUncopiedDocument } from "./markdown.mjs";
import { safeResolve } from "./paths.mjs";
import { courseState, newIds } from "./state.mjs";

// Additive: a run that finds less than the last one leaves the earlier files alone (ADR-0003).
export async function syncCourse({ client, course, state }) {
  const snapshot = await client.readCourse(course.courseId);
  const previous = courseState(state, course.key);
  const unread = Object.entries(snapshot.unavailable ?? {})
    .filter(([, couldNotBeRead]) => couldNotBeRead)
    .map(([category]) => category);
  const tally = {
    downloaded: 0,
    skipped: 0,
    bytes: 0,
    markdown: 0,
    markdownWritten: 0,
    uncopied: 0,
    failures: [],
  };
  const downloads = {};

  await mkdir(course.destination, { recursive: true });

  for await (const expected of expectedFiles({
    client,
    courseId: course.courseId,
    snapshot,
  })) {
    const target = safeResolve(course.destination, ...expected.placement.segments);

    switch (expected.kind) {
      case "folder":
        await mkdir(target, { recursive: true });
        break;
      case "document":
        await writeDocument(target, expected.content, tally);
        break;
      case "uncopied":
        tally.uncopied += 1;
        await writeUncopied(target, expected.content, tally);
        break;
      case "attachment": {
        const { item, attachment, placement } = expected;
        const record = previous.downloads?.[attachment.resourceUrl];
        const saved = await saveAttachment({
          client,
          target,
          placement,
          item,
          attachment,
          record,
          tally,
        });
        if (saved) downloads[attachment.resourceUrl] = saved;
        break;
      }
    }
  }

  const current = {
    courseId: course.courseId,
    destination: course.destination,
    syncedAt: new Date().toISOString(),
    downloads,
    contentIds: snapshot.items.map((item) => item.id),
    // A category nobody could read yields the same empty list as a category with nothing in it, and
    // the two are not the same fact. Recording the empty one would report every announcement as new
    // on the run after the permission comes back, so an unread category keeps what the last run
    // recorded — ADR-0003's direction, one level up from the files.
    announcementIds: unread.includes("announcements")
      ? previous.announcementIds
      : snapshot.announcements.map((announcement) => announcement.id),
    conversationIds: unread.includes("conversations")
      ? previous.conversationIds
      : snapshot.conversations.map((conversation) => conversation.id),
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
    // Said only when there is something to say, because a category nobody could read is the one
    // thing in this result a count cannot show: it looks exactly like a category with nothing in it.
    ...(unread.length ? { unread } : {}),
    ...tally,
  };
}

async function saveAttachment({ client, target, placement, item, attachment, record, tally }) {
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
    const { body, headers } = await client.download(attachment);
    await writeAtomically(target, body);
    tally.downloaded += 1;
    tally.bytes += body.length;
    return {
      fingerprint,
      relativePath: placement.path,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      // Written, never read: what a run may consult `State` for is ADR-0005's, not this line's.
      ...downloadedType(attachment, headers),
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

// An item hidden by a release rule reads exactly like one there was never anything to copy from, so
// a page the student already has is never replaced by the statement that there is nothing to copy —
// additive in the direction ADR-0003 argues for. That statement is the sync's own writing, though,
// and correcting it costs the student nothing, so a destination written before a fix stops
// repeating what the fix removed (#53).
async function writeUncopied(path, content, tally) {
  const existing = await readText(path);
  if (existing !== null && !isUncopiedDocument(existing)) return;
  await writeDocument(path, content, tally);
}

function attachmentFingerprint(item, attachment) {
  return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
}

// Two numbers because they answer different questions: how big the copy is, and what this run did
// to it. Only the second is worth a reader's attention on a run nobody watched, and a count that
// reads the same whether everything or nothing was written cannot be it.
async function writeDocument(path, content, tally) {
  if (!content) return;
  if (await writeIfChanged(path, content)) tally.markdownWritten += 1;
  tally.markdown += 1;
}
