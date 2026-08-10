import { expectedAttachments } from "./attachments.mjs";
import { isFilePresent } from "./files.mjs";
import { safeResolve } from "./paths.mjs";

// What NTULearn has, held against what is in the destination. A sync reports on its own run, so it
// cannot answer whether a course is complete — the gaps worth knowing about are the older ones.
// This reads both sides and writes to neither, which is why it is safe under ADR-0003.
export async function verifyCourse({ client, course }) {
  const snapshot = await client.readCourse(course.courseId);
  const missing = [];
  let attachments = 0;

  for await (const { placement } of expectedAttachments({
    client,
    courseId: course.courseId,
    items: snapshot.items,
  })) {
    attachments += 1;
    if (await isFilePresent(safeResolve(course.destination, ...placement.segments))) continue;
    missing.push({ file: placement.file, trail: placement.trail, path: placement.path });
  }

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    attachments,
    present: attachments - missing.length,
    missing,
  };
}

export function verifyReport(courses) {
  const attachments = total(courses, "attachments");
  const present = total(courses, "present");
  return { attachments, present, complete: present === attachments, courses };
}

function total(courses, field) {
  return courses.reduce((running, course) => running + course[field], 0);
}
