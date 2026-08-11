import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "../src/config.mjs";
import { openClient } from "../src/ntulearn/client.mjs";
import { writeLine } from "../src/output.mjs";
import { expectedAttachments } from "../src/sync/attachments.mjs";
import { openSecondReader } from "./second-reader.mjs";

// The set difference, both directions, between what `verify` expects a course to hold and what a
// reader that shares none of its code can find (#29). `verify` checks its numerator against the
// filesystem and takes its denominator on trust; this is the denominator asked a second time.
//
// Two passes rather than one, because Chrome locks the profile directory: the walk gets a session,
// gives it back, and then the second reader takes one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://ntulearn.ntu.edu.sg";
const FILE_SHAPED = /\/bbcswebdav\/|xid-/i;
const USAGE = "Usage: node prototype/compare.mjs <course|all>";

async function walked(profilePath, courses) {
  const client = await openClient(profilePath);
  const byKey = new Map();

  try {
    for (const course of courses) {
      await writeLine(stderr, `walk: ${course.key}`);
      const snapshot = await client.readCourse(course.courseId);
      const attachments = [];
      for await (const { attachment, placement } of expectedAttachments({
        client,
        courseId: course.courseId,
        items: snapshot.items,
      })) {
        attachments.push({
          url: comparable(attachment.resourceUrl),
          file: placement.file,
          path: placement.path,
        });
      }
      byKey.set(course.key, {
        course: snapshot.course.displayName,
        items: snapshot.items.length,
        attachments,
      });
    }
  } finally {
    await client.close();
  }

  return byKey;
}

async function grepped(profilePath, courses) {
  const secondReader = await openSecondReader(profilePath);
  const byKey = new Map();

  try {
    for (const course of courses) {
      await writeLine(stderr, `grep: ${course.key}`);
      byKey.set(course.key, await secondReader.read(course.courseId));
    }
  } finally {
    await secondReader.close();
  }

  return byKey;
}

// What the walk missed is split by shape, because "any link back at NTULearn" was asked for and
// most of what it catches is a page rather than a file. The file-shaped half is the #26 family;
// the other half is the pile to read once.
function difference(course, walk, reader) {
  const expected = new Map(walk.attachments.map((attachment) => [attachment.url, attachment]));
  const found = new Map(reader.links.map((link) => [comparable(link.link), link]));
  const missedByTheWalk = [...found]
    .filter(([url]) => !expected.has(url))
    .map(([url, link]) => ({
      url,
      item: link.itemTitle,
      itemId: link.itemId,
      field: link.field,
      context: link.context,
    }));

  return {
    key: course.key,
    course: walk.course,
    items: { walk: walk.items, reader: reader.items },
    attachments: { walk: expected.size, reader: found.size },
    missedByTheWalk: {
      fileShaped: missedByTheWalk.filter((each) => FILE_SHAPED.test(each.url)),
      // Without the markup, because this pile is read once for what is in it rather than diagnosed.
      other: missedByTheWalk
        .filter((each) => !FILE_SHAPED.test(each.url))
        .map(({ url, item, itemId, field }) => ({ url, item, itemId, field })),
    },
    missedByTheReader: [...expected.values()].filter((each) => !found.has(each.url)),
    unreadable: reader.unreadable,
  };
}

// Both sides through one normalisation, because the two disagree about a query string — the walk
// keeps one on an element's own link and drops it on a viewer URL — and a difference that is only
// a query string is a difference about display options rather than about a file.
function comparable(url) {
  try {
    const { origin, pathname } = new URL(url, BASE_URL);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
}

async function main([key]) {
  if (!key) {
    await writeLine(stderr, USAGE);
    return 1;
  }

  const config = await loadConfig(ROOT);
  const courses = selectCourses(config.courses, key);
  const walk = await walked(config.profilePath, courses);
  const reader = await grepped(config.profilePath, courses);

  const report = courses.map((course) =>
    difference(course, walk.get(course.key), reader.get(course.key)),
  );
  await writeLine(stdout, JSON.stringify({ courses: report }, null, 2));

  return report.some((each) => each.missedByTheWalk.fileShaped.length) ? 1 : 0;
}

const status = await main(process.argv.slice(2)).catch(async (error) => {
  await writeLine(stderr, error.message);
  return 1;
});

process.exit(status);
