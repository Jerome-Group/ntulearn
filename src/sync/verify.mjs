import { isFileOfSize } from "./files.mjs";
import { safeResolve } from "./paths.mjs";
import { attachmentPlacement, placementsIn } from "./placement.mjs";

// What NTULearn has, held against what is in the destination. A sync reports on its own run, so it
// cannot answer whether a course is complete — the gaps worth knowing about are the older ones.
// This reads both sides and writes to neither, which is why it is safe under ADR-0003.
export async function verifyCourse({ client, course }) {
  const snapshot = await client.readCourse(course.courseId);
  const placements = placementsIn(snapshot.items);
  const missing = [];
  let attachments = 0;

  for (const item of snapshot.items) {
    for (const attachment of await client.readAttachments(course.courseId, item)) {
      const at = attachmentPlacement(placements.get(item.id), item, attachment);
      attachments += 1;
      if (await isFileOfSize(safeResolve(course.destination, ...at.segments))) continue;
      missing.push({ file: at.file, trail: at.trail, path: at.path });
    }
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
