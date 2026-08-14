import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { downloadedType } from "../ntulearn/download.mjs";
import { expectedFiles } from "./expected.mjs";
import { fileHolds, isFilePresent, readText, writeAtomically, writeIfChanged } from "./files.mjs";
import { isUncopiedDocument, syncStamp } from "./markdown.mjs";
import { numberingOf } from "./numbering.mjs";
import { safeResolve, safeSegment } from "./paths.mjs";
import { courseState, newIds } from "./state.mjs";

// Alone here rather than beside the other destination filenames in `expected.mjs`, because that
// walk is what `verify` holds a destination against and a stamp is no part of what a course is
// expected to hold (ADR-0008).
const SYNC_STAMP = "Last synced.md";

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
    renumbered: 0,
    failures: [],
  };
  const downloads = {};

  await mkdir(course.destination, { recursive: true });

  // Read whole before written, because where a file belongs is decided among every name the course
  // expects rather than by that name alone — the sibling `numberingOf` needs and the reason
  // `verify` walks the same way (ADR-0005).
  const walked = [];
  for await (const expected of expectedFiles({ client, courseId: course.courseId, snapshot })) {
    walked.push(expected);
  }
  const numbering = numberingOf(
    course.destination,
    walked.map((expected) => expected.placement.segments),
  );

  for (const expected of walked) {
    const place = await placeOf(numbering, course.destination, expected);
    if (place.heldAt) tally.renumbered += 1;

    switch (expected.kind) {
      case "folder":
        await mkdir(place.target, { recursive: true });
        break;
      case "document":
        await writeDocument(place, expected.content, tally);
        break;
      case "uncopied":
        tally.uncopied += 1;
        await writeUncopied(place, expected.content, tally);
        break;
      case "attachment": {
        const { item, attachment, placement } = expected;
        const record = previous.downloads?.[attachment.resourceUrl];
        const saved = await saveAttachment({
          client,
          place,
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

  const syncedAt = new Date().toISOString();
  // Outside the walk, counted in neither number, and written whatever the run found: a run whose
  // downloads failed is still a run that happened, and this is the only place the destination says
  // so. `state.syncedAt` records the same moment, but `.data/` is disposable and no part of the
  // copy (ADR-0008).
  await writeAtomically(safeResolve(course.destination, SYNC_STAMP), syncStamp(syncedAt));

  const current = {
    courseId: course.courseId,
    destination: course.destination,
    syncedAt,
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

// Where a run writes one thing the course expects, and where the destination already holds it. The
// two are the same name until an item is inserted upstream: a name carries its item's position, so
// every later name moves by one while nothing on disk moves with it (ADR-0003). `heldAt` is the
// older file when there is one, and it is never written over — a run keeps it where it is, or
// writes at today's number beside it (ADR-0009).
//
// The folder is resolved first and the name resolved inside it, so a file the destination does not
// hold yet joins its siblings rather than opening a second folder beside them. Resolving only the
// file would leave a reordered course split across two directories — the old one holding everything
// that was there and a new one holding everything since.
async function placeOf(numbering, destination, expected) {
  const { path, segments } = expected.placement;
  if (expected.kind === "folder") {
    return { at: path, target: await directoryFor(numbering, destination, segments), heldAt: null };
  }

  const found = await numbering.find(segments);
  const within =
    found !== null
      ? dirname(resolve(destination, found))
      : await directoryFor(numbering, destination, segments.slice(0, -1));
  const target = join(within, safeSegment(segments.at(-1)));
  const older = found === null ? null : resolve(destination, found);
  return older === null || older === target
    ? { at: path, target, heldAt: null }
    : { at: found, target, heldAt: older };
}

// The directory these segments name, wherever the destination holds it. `resolve` rather than
// `safeResolve` on that answer: the name came off a listing of the destination itself, so it is
// already a name on disk rather than anything NTULearn said.
async function directoryFor(numbering, destination, segments) {
  if (!segments.length) return destination;
  const here = await numbering.directory(segments);
  return here === null ? safeResolve(destination, ...segments) : resolve(destination, here);
}

async function saveAttachment({ client, place, placement, item, attachment, record, tally }) {
  const fingerprint = attachmentFingerprint(item, attachment);
  // A record used to have to name the path this run would write, and the number in that path moves
  // under it — so an item pushed down the course read as changed and was fetched a second time
  // beside itself, sixty-one of them in one course (#70, ADR-0009).
  const known = record?.fingerprint === fingerprint;

  if (known && (await isFilePresent(place.target, attachment.fileSize))) {
    tally.skipped += 1;
    return { ...record, relativePath: place.at };
  }
  if (known && place.heldAt !== null && (await isFilePresent(place.heldAt, attachment.fileSize))) {
    tally.skipped += 1;
    return record;
  }

  try {
    const { body, headers } = await client.download(attachment);
    // A run with no record of these bytes is what deleting `State` leaves, and asking the
    // destination rather than the record is what lets that run keep the file where it is instead of
    // writing a second copy of it. The bytes are compared rather than assumed, because nothing this
    // run did not just fetch is ever written over (ADR-0003, ADR-0009).
    const alreadyThere = place.heldAt !== null && (await fileHolds(place.heldAt, body));
    if (alreadyThere) {
      tally.skipped += 1;
    } else {
      await writeAtomically(place.target, body);
      tally.downloaded += 1;
      tally.bytes += body.length;
    }
    return {
      fingerprint,
      relativePath: alreadyThere ? place.at : placement.path,
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
//
// The page it must not write over is wherever the earlier run left it, which a reorder moves away
// from the name today's numbering gives it (ADR-0009).
async function writeUncopied(place, content, tally) {
  const existing = await readText(place.heldAt ?? place.target);
  if (existing !== null && !isUncopiedDocument(existing)) return;
  await writeDocument(place, content, tally);
}

function attachmentFingerprint(item, attachment) {
  return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
}

// Two numbers because they answer different questions: how big the copy is, and what this run did
// to it. Only the second is worth a reader's attention on a run nobody watched, and a count that
// reads the same whether everything or nothing was written cannot be it.
//
// A document under an earlier number holding these very words is this document, and writing it
// again at today's number would put a second copy of the same text in the folder with nothing to
// say which is current. Where the words differ the older file is left exactly as it is — it may be
// the student's — and the run writes beside it (ADR-0003, ADR-0009).
async function writeDocument(place, content, tally) {
  if (!content) return;
  if (place.heldAt !== null && (await readText(place.heldAt)) === content) {
    tally.markdown += 1;
    return;
  }
  if (await writeIfChanged(place.target, content)) tally.markdownWritten += 1;
  tally.markdown += 1;
}
