import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "../src/config.mjs";
import { openClient } from "../src/ntulearn/client.mjs";
import { externalLinkOf, kindOf } from "../src/ntulearn/content.mjs";
import { writeLine } from "../src/output.mjs";
import { expectedAttachments } from "../src/sync/attachments.mjs";
import { placementsIn } from "../src/sync/placement.mjs";
import { differenceBetween } from "./difference.mjs";
import { foundSomethingNew, renderReport } from "./report.mjs";
import { openRenderedPageReader } from "./rendered-page.mjs";

// The two-way difference between what a course's rendered pages carry and what a sync expects it
// to hold (#45). It downloads nothing and writes nowhere: the report goes to stdout and the
// progress to stderr, and NTULearn is read exactly as the student could read it themselves.
//
// Two passes rather than one, because Chrome locks the profile directory: the walk takes a
// session, gives it back, and then the reader takes one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: node prototype/page-vs-walk.mjs <course|all>";

// `expectedAttachments` called exactly as `sync` and `verify` call it, rather than a reading of the
// same items that agrees with them today. The point of the comparison is the thing itself.
async function walked(profilePath, courses) {
  const client = await openClient(profilePath);
  const byKey = new Map();

  try {
    for (const course of courses) {
      await writeLine(stderr, `walk: ${course.key}`);
      byKey.set(course.key, await walkedCourse(client, course));
    }
  } finally {
    await client.close();
  }

  return byKey;
}

async function walkedCourse(client, course) {
  try {
    const snapshot = await client.readCourse(course.courseId);
    const attachments = [];

    for await (const { attachment, placement } of expectedAttachments({
      client,
      courseId: course.courseId,
      items: snapshot.items,
    })) {
      attachments.push({
        url: attachment.resourceUrl,
        kind: "attachment",
        name: placement.file,
        trail: placement.trail,
        path: placement.path,
      });
    }

    return {
      course: snapshot.course.displayName,
      attachments: [...attachments, ...linked(snapshot)],
    };
  } catch (error) {
    return { failure: `the walk could not read it: ${error.message}` };
  }
}

// The links as well as the attachments, and `externalLinkOf` called exactly as `src/sync/course.mjs`
// calls it. Attachments alone was the shape of #45's fourth criterion and it made the comparison
// blind on both sides at once: an external-link item carries no attachment, so 44 of PS0002's 126
// items were invisible to the walk — and every one of them is a video lecture.
//
// A page and a walk that agree because neither can see something is the failure #29 exists to
// prevent. Whether the criterion or the comparison was wrong is #33's to settle; what is not in
// question is that a number counted this way says nothing about a course's recordings.
function linked(snapshot) {
  const placements = placementsIn(snapshot.items);
  const links = [];

  for (const item of snapshot.items) {
    const url = externalLinkOf(item);
    if (!url) continue;
    links.push({
      url,
      kind: kindOf(item),
      name: item.title,
      trail: placements.get(item.id)?.trail ?? "",
      path: "—",
    });
  }

  return links;
}

async function rendered(profilePath, courses) {
  const reader = await openRenderedPageReader(profilePath);
  const byKey = new Map();

  try {
    for (const course of courses) {
      await writeLine(stderr, `page: ${course.key}`);
      byKey.set(
        course.key,
        await reader
          .read(course.courseId)
          .catch((error) => ({ failure: `the rendered page could not be read: ${error.message}` })),
      );
    }
  } finally {
    await reader.close();
  }

  return byKey;
}

// A course either side failed on has no difference to report — a difference against half a reading
// is a number that looks like an answer. It is carried through as the failure it is.
function differenceFor(course, walk, page) {
  const failure = walk.failure ?? page.failure;
  if (failure) return { key: course.key, courseId: course.courseId, failure };

  return {
    key: course.key,
    courseId: course.courseId,
    course: walk.course,
    items: page.items,
    unreadableItems: page.unreadableItems,
    difference: differenceBetween({ objects: page.objects, attachments: walk.attachments }),
  };
}

async function main([key]) {
  if (!key) {
    await writeLine(stderr, USAGE);
    return 1;
  }

  const config = await loadConfig(ROOT);
  const courses = selectCourses(config.courses, key);
  const walk = await walked(config.profilePath, courses);
  const page = await rendered(config.profilePath, courses);

  const report = courses.map((course) =>
    differenceFor(course, walk.get(course.key), page.get(course.key)),
  );
  await writeLine(stdout, renderReport(report));

  return foundSomethingNew(report) ? 1 : 0;
}

const status = await main(process.argv.slice(2)).catch(async (error) => {
  await writeLine(stderr, error.message);
  return 1;
});

process.exit(status);
