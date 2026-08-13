import { expectedFiles } from "./expected.mjs";
import { isFilePresent } from "./files.mjs";
import { safeResolve } from "./paths.mjs";

// Where the number stops. Completeness is only ever relative to the authority behind it — here, one
// read of the course — so what that read does not reach is part of the answer rather than a caveat
// on it (`CONTEXT.md`, *Authority*).
const NOT_COVERED = [
  "A content item this walk did not return expects nothing, so it is missing from the count it is missing from.",
  "An object that is neither an attachment nor a document — a recorded lecture's video, whatever an external tool holds — is read by neither side.",
  "A file at the path is never opened, so a truncated or since-replaced one counts as present (docs/adr/0005).",
];

// What NTULearn has, held against what is in the destination. A sync reports on its own run, so it
// cannot answer whether a course is complete — the gaps worth knowing about are the older ones.
// This reads both sides and writes to neither, which is why it is safe under ADR-0003.
//
// It looks only where NTULearn told it to look, and never walks the destination: a file the course
// has stopped returning an item for is correctly on disk (ADR-0003) and is invisible here.
export async function verifyCourse({ client, course }) {
  const snapshot = await client.readCourse(course.courseId);
  const missing = [];
  let attachments = 0;
  let documents = 0;

  for await (const expected of expectedFiles({
    client,
    courseId: course.courseId,
    snapshot,
  })) {
    // A folder is a directory rather than a file, and what it is expected to say is its own
    // document, which arrives here separately.
    if (expected.kind === "folder") continue;
    if (expected.kind === "attachment") attachments += 1;
    else documents += 1;

    const { file, trail, path, segments } = expected.placement;
    if (await isFilePresent(safeResolve(course.destination, ...segments))) continue;
    missing.push({ file, trail, path });
  }

  const files = attachments + documents;
  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    files,
    attachments,
    documents,
    present: files - missing.length,
    missing,
  };
}

export function verifyReport(courses) {
  const files = total(courses, "files");
  const present = total(courses, "present");
  return {
    files,
    attachments: total(courses, "attachments"),
    documents: total(courses, "documents"),
    present,
    complete: present === files,
    courses,
    notCovered: NOT_COVERED,
  };
}

function total(courses, field) {
  return courses.reduce((running, course) => running + course[field], 0);
}
