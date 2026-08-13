import { expectedFiles } from "./expected.mjs";
import { isFilePresent } from "./files.mjs";
import { safeResolve } from "./paths.mjs";

// Where the number stops. Completeness is only ever relative to the authority behind it — here, one
// read of the course — so what that read does not reach is part of the answer rather than a caveat
// on it (`CONTEXT.md`, *Authority*).
const NOT_COVERED = [
  "A content item this walk did not return expects nothing, so it is missing from the count it is missing from.",
  "A category NTULearn would not return — named as `unread` on the course below — expects nothing either, for the same reason.",
  "A course NTULearn would not hand over — named under `refused` below — is absent from both numbers entirely: it was never read, so nothing of it is counted, present or missing.",
  "An object that is neither an attachment nor a document — a recorded lecture's video, whatever an external tool holds — is read by neither side.",
  "A file at the path is never opened, so a truncated or since-replaced one counts as present (docs/adr/0005).",
];

// The categories this count is made of. A conversation is never copied, so a course that would not
// hand its conversations over is a course this command expected nothing of in the first place.
const COUNTED_CATEGORIES = ["announcements"];

// Which number each thing the walk expects belongs in. A folder is absent from this on purpose: it
// is a directory rather than a file, and what it is expected to say is its own document, which the
// walk yields separately.
const COUNTED_AS = { attachment: "attachments", document: "documents", uncopied: "documents" };

// What NTULearn has, held against what is in the destination. A sync reports on its own run, so it
// cannot answer whether a course is complete — the gaps worth knowing about are the older ones.
// This reads both sides and writes to neither, which is why it is safe under ADR-0003.
//
// It looks only where NTULearn told it to look, and never walks the destination: a file the course
// has stopped returning an item for is correctly on disk (ADR-0003) and is invisible here.
export async function verifyCourse({ client, course }) {
  const snapshot = await client.readCourse(course.courseId);
  const counted = { attachments: 0, documents: 0 };
  const missing = [];

  for await (const expected of expectedFiles({
    client,
    courseId: course.courseId,
    snapshot,
  })) {
    const number = COUNTED_AS[expected.kind];
    if (!number) continue;
    counted[number] += 1;

    const { file, trail, path, segments } = expected.placement;
    if (await isFilePresent(safeResolve(course.destination, ...segments))) continue;
    missing.push({ file, trail, path });
  }

  const files = counted.attachments + counted.documents;
  // A category nobody could read hands back the same empty list as a category with nothing in it,
  // so a count made from it is complete by having expected nothing — the vacuity this command was
  // failing on one level up (#32). There is no remedy to point at, so it is said rather than
  // reddened: what the number does not cover is part of the answer.
  const unread = COUNTED_CATEGORIES.filter((category) => snapshot.unavailable?.[category]);

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    files,
    ...counted,
    present: files - missing.length,
    missing,
    ...(unread.length ? { unread } : {}),
  };
}

// A refused course is beside the courses rather than among them, and leaves `complete` alone:
// it has no files and no present, so a row like the others would be zeroes nobody read off a
// course. ADR-0005 argues both halves.
export function verifyReport(courses, refused = []) {
  const files = total(courses, "files");
  const present = total(courses, "present");
  return {
    files,
    attachments: total(courses, "attachments"),
    documents: total(courses, "documents"),
    present,
    complete: present === files,
    courses,
    ...(refused.length ? { refused } : {}),
    notCovered: NOT_COVERED,
  };
}

function total(courses, field) {
  return courses.reduce((running, course) => running + course[field], 0);
}
