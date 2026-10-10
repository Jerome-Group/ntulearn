import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { downloadedType } from "../ntulearn/download.mjs";
import { ambiguousPaths, comparablePath, expectedFiles } from "./expected.mjs";
import {
  fileDigest,
  isFilePresent,
  readText,
  writeAtomically,
  writeWithoutReplacing,
} from "./files.mjs";
import { withImportStatus } from "./import-status.mjs";
import { isUncopiedDocument, syncStamp } from "./markdown.mjs";
import { numberingOf } from "./numbering.mjs";
import { assertDestinationPath, safeResolve, safeSegment } from "./paths.mjs";
import { recordSourceEdition } from "./source-provenance.mjs";
import {
  resolveSourceEditions,
  attachmentStateKey,
  attachmentFingerprint,
} from "./source-editions.mjs";
import { courseState, newIds } from "./state.mjs";

// Alone here rather than beside the other destination filenames in `expected.mjs`, because that
// walk is what `verify` holds a destination against and a stamp is no part of what a course is
// expected to hold (ADR-0008).
const SYNC_STAMP = "Last synced.md";

// Additive: a run that finds less than the last one leaves the earlier files alone (ADR-0003).
export async function syncCourse({ client, course, state, recordingDiscovery = () => [] }) {
  return withImportStatus({
    destination: course.destination,
    attempt: () => syncCourseAttempt({ client, course, state, recordingDiscovery }),
  });
}

async function syncCourseAttempt({ client, course, state, recordingDiscovery }) {
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
    newEditions: 0,
    reusedFiles: 0,
    unresolvedIdentity: 0,
    publicationConflicts: 0,
    failures: [],
  };
  const downloads = {};

  await mkdir(course.destination, { recursive: true });

  // Read whole before written, because where a file belongs is decided among every name the course
  // expects rather than by that name alone — the sibling `numberingOf` needs and the reason
  // `verify` walks the same way (ADR-0005).
  let walked = [];
  const attachmentsByItem = new Map();
  for await (const expected of expectedFiles({
    client,
    courseId: course.courseId,
    snapshot,
    onAttachments: (item, attachments) => attachmentsByItem.set(item.id, attachments),
  })) {
    walked.push(expected);
  }
  // Media discovery belongs to the walk, but acquisition belongs to the separate media job. The
  // sync therefore returns safe appearance records and writes none of their media artifacts.
  const recordings =
    course.mediaMode && course.mediaMode !== "off"
      ? recordingDiscovery({ course, snapshot, attachmentsByItem })
      : [];
  walked = await resolveSourceEditions({
    walked,
    destination: course.destination,
    previous,
    loadAttachment: (attachment) => client.download(attachment),
  });
  const numbering = numberingOf(
    course.destination,
    walked.map((expected) => expected.placement.segments),
  );

  const ambiguous = ambiguousPaths(walked);
  const placed = [];
  for (const expected of walked) {
    const place = await placeOf(numbering, course.destination, expected);
    await assertDestinationPath(course.destination, place.target);
    if (place.heldAt !== null) await assertDestinationPath(course.destination, place.heldAt);
    placed.push({ expected, place });
  }
  await assertDestinationPath(course.destination, safeResolve(course.destination, SYNC_STAMP));

  for (const { expected, place } of placed) {
    if (expected.sourceFailure) {
      const { file, trail, path } = expected.placement;
      const conflict = expected.sourceFailure === "SOURCE_PUBLICATION_CONFLICT";
      if (conflict) tally.publicationConflicts++;
      else if (expected.sourceFailure !== "SOURCE_FETCH_FAILED") tally.unresolvedIdentity++;
      tally.failures.push({
        file,
        trail,
        path,
        code: expected.sourceFailure,
        error:
          expected.sourceError ??
          (conflict
            ? "Source edition has different occupied bytes. Existing edits were retained. Compare the original and its edition before retrying."
            : "Source identity, revision or placement is missing or ambiguous. Existing files were retained. Report the source defect before retrying."),
      });
      continue;
    }
    if (
      expected.kind !== "folder" &&
      ambiguous.has(comparablePath(expected.placement, expected.sourcePath))
    ) {
      const { file, trail, path } = expected.placement;
      tally.failures.push({
        file,
        trail,
        path,
        error:
          "Distinct course files share this destination name. Existing files were retained. Report an ntulearn naming defect before retrying.",
      });
      continue;
    }
    if (place.heldAt || (place.sourcePinned && place.at !== expected.placement.path))
      tally.renumbered += 1;

    switch (expected.kind) {
      case "folder":
        await mkdir(place.target, { recursive: true });
        break;
      case "document":
        if (
          await writeDocument(place, expected.content, tally, expected.placement, expected.edition)
        )
          await recordSourceEdition(course.destination, expected, place.heldAt ?? place.target);
        break;
      case "uncopied":
        tally.uncopied += 1;
        await writeUncopied(place, expected.content, tally, expected.placement);
        break;
      case "attachment": {
        const { item, attachment, placement } = expected;
        const previousRecord =
          previous.downloads?.[attachmentStateKey(attachment)] ??
          previous.downloads?.[attachment.resourceUrl];
        const record = expected.provenance
          ? {
              fingerprint: attachmentFingerprint(item, attachment),
              relativePath: expected.sourcePath ?? expected.provenance.relativePath,
              bytes: expected.provenance.bytes,
              sha256: expected.provenance.sha256,
            }
          : previousRecord;
        const beforeDownloads = tally.downloaded;
        const saved = await saveAttachment({
          client,
          place,
          placement,
          item,
          attachment,
          record,
          tally,
          fetchedRevision: expected.fetchedRevision,
          revisionDigest: expected.source.version,
        });
        if (saved) {
          await recordSourceEdition(
            course.destination,
            expected,
            place.heldAt ?? place.target,
            saved,
          );
          if (expected.edition && tally.downloaded > beforeDownloads) tally.newEditions++;
          downloads[attachmentStateKey(attachment)] = {
            ...saved,
            relativePath: place.sourcePinned ? place.at : saved.relativePath,
            sourceIdentity: expected.source.identity,
          };
        }
        break;
      }
    }
  }

  const syncedAt = new Date().toISOString();
  // Outside the walk and counted in neither number: the stamp tells a person when the walk finished,
  // while the import-status wrapper publishes its health for a machine. `state.syncedAt` records the
  // same moment, but `.data/` is disposable and no part of the copy (ADR-0008, ADR-0015).
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
    recordings,
    ...tally,
  };
}

// Where a run writes one thing the course expects, and where the destination already holds it. The
// two are the same name until an item is inserted upstream: a name carries its item's position, so
// every later name moves by one while nothing on disk moves with it (ADR-0003). `heldAt` is the
// older file when there is one. A run keeps identical bytes there and reports differing occupied
// bytes as a manual conflict (ADR-0016). Positive source revisions use exclusive editions
// instead (ADR-0027); neither case uses a new number as a rescue path.
//
// The folder is resolved first and the name resolved inside it, so a file the destination does not
// hold yet joins its siblings rather than opening a second folder beside them. Resolving only the
// file would leave a reordered course split across two directories — the old one holding everything
// that was there and a new one holding everything since.
async function placeOf(numbering, destination, expected) {
  if (expected.sourcePath)
    return {
      at: expected.sourcePath,
      target: resolve(destination, expected.sourcePath),
      heldAt: null,
      sourcePinned: true,
    };
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

async function saveAttachment({
  client,
  place,
  placement,
  item,
  attachment,
  record,
  tally,
  fetchedRevision,
  revisionDigest,
}) {
  const fingerprint = attachmentFingerprint(item, attachment);
  // A record used to have to name the path this run would write, and the number in that path moves
  // under it — so an item pushed down the course read as changed and was fetched a second time
  // beside itself, sixty-one of them in one course (#70, ADR-0009). Actual recorded bytes are the
  // skip evidence: upstream fileSize can be wrong, and legacy records without bytes are compared.
  const known =
    record?.fingerprint === fingerprint ||
    record?.fingerprint === attachmentFingerprint(item, attachment, { legacy: true });

  if (
    !fetchedRevision &&
    known &&
    validByteCount(record?.bytes) &&
    /^[a-f0-9]{64}$/.test(record?.sha256 ?? "") &&
    (await fileDigest(place.target)) === record.sha256
  ) {
    tally.skipped += 1;
    tally.reusedFiles += 1;
    return retainedDownload(record, place.at, fingerprint);
  }
  if (
    !fetchedRevision &&
    known &&
    validByteCount(record?.bytes) &&
    /^[a-f0-9]{64}$/.test(record?.sha256 ?? "") &&
    place.heldAt !== null &&
    (await fileDigest(place.heldAt)) === record.sha256
  ) {
    tally.skipped += 1;
    tally.reusedFiles += 1;
    return retainedDownload(record, record.relativePath, fingerprint);
  }

  try {
    const { body, headers } = await client.download(attachment);
    if (revisionDigest && createHash("sha256").update(body).digest("hex") !== revisionDigest) {
      const changed = Error("Source changed between revision reads. Retry after NTULearn settles.");
      changed.code = "SOURCE_REVISION_CHANGED";
      throw changed;
    }
    // An older placement is occupied too. Different bytes require a manual conflict rather than
    // a second name at today's number (ADR-0016). A positively identified revision already has
    // its own exclusive placement (ADR-0027).
    const written = await writeWithoutReplacing(place.heldAt ?? place.target, body);
    if (written) {
      tally.downloaded += 1;
      tally.bytes += body.length;
    } else {
      tally.skipped += 1;
      tally.reusedFiles += 1;
    }
    return {
      fingerprint,
      relativePath: place.heldAt !== null ? place.at : placement.path,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      // Written, never read: what a run may consult `State` for is ADR-0005's, not this line's.
      ...retainedTypes(downloadedType(attachment, headers)),
    };
  } catch (error) {
    // Where it was and where it would have gone, because the item's own title is `ultraDocumentBody`
    // for every embedded document in a course and so names nothing (#21).
    if (error.code === "SYNC_FILE_CONFLICT") tally.publicationConflicts++;
    tally.failures.push({
      ...(error.code ? { code: error.code } : {}),
      file: placement.file,
      trail: placement.trail,
      path: placement.path,
      error: error.message,
    });
    // No record, so the next run treats this attachment as never downloaded and tries again.
    return null;
  }
}

// A release-rule read cannot replace an earlier page with a stand-in. Marked stand-ins still go
// through the byte comparison: the mark identifies their origin, not the absence of user edits.
async function writeUncopied(place, content, tally, placement) {
  const occupied = place.heldAt ?? place.target;
  if (await isFilePresent(occupied)) {
    const existing = await readText(occupied);
    if (existing !== null && !isUncopiedDocument(existing)) return;
  }
  await writeDocument(place, content, tally, placement);
}

// Counts describe material accepted by this run; a conflicting occupied path is a failure rather
// than a successful write. ADR-0016 keeps even marked stand-ins once somebody may have annotated them.
async function writeDocument(place, content, tally, placement, edition = false) {
  if (!content) return;
  try {
    if (await writeWithoutReplacing(place.heldAt ?? place.target, content)) {
      tally.markdownWritten += 1;
      if (edition) tally.newEditions++;
    } else tally.reusedFiles++;
    tally.markdown += 1;
    return true;
  } catch (error) {
    const { file, trail, path } = placement;
    if (error.code === "SYNC_FILE_CONFLICT") tally.publicationConflicts++;
    tally.failures.push({ file, trail, path, error: error.message });
  }
}

function validByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function retainedDownload(record, relativePath, fingerprint) {
  return {
    fingerprint,
    relativePath,
    bytes: record.bytes,
    sha256: record.sha256,
    ...retainedTypes(record),
  };
}
function retainedTypes(record) {
  return Object.fromEntries(
    ["mimeType", "claimedMimeType"]
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [
        field,
        typeof record[field] === "string" &&
        /https?:\/\/|[?&](?:ks|token|session|signature|sig)=/i.test(record[field])
          ? null
          : record[field],
      ]),
  );
}
