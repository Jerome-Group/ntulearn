import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "../src/config.mjs";
import { openClient } from "../src/ntulearn/client.mjs";
import { writeLine } from "../src/output.mjs";
import { countCourse } from "./undescribed.mjs";

// The count [#78](https://github.com/Jerome-Group/ntulearn/issues/78) asks for before anything is
// built: across the configured courses, how many bodies carry a `/bbcswebdav/` address on an `<a>`
// or an `<img>` with no `data-bbfile` — and of those addresses, how many are the item's own
// attachment wearing a second address rather than a file nothing downloads.
//
// That second half is the whole reason this is a count rather than a change. #77 wrote the note
// from the conversion layer, which holds the HTML and not the item, and so could not tell the two
// apart; `docs/adr/0011` records the refusal. This program has the item, asks the client for the
// same attachments a sync would download, and reports the split. `undescribed.mjs` is the count
// itself; this is the session around it.
//
// It reads. It downloads nothing, writes nothing to any destination, and touches no sync state.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: node prototype/count-undescribed.mjs <course|all>";

async function main([key]) {
  if (!key) {
    await writeLine(stderr, USAGE);
    return 1;
  }

  const config = await loadConfig(ROOT);
  const courses = selectCourses(config.courses, key);
  const client = await openClient(config.profilePath);
  const report = [];

  try {
    for (const course of courses) {
      await writeLine(stderr, `count: ${course.key}`);
      try {
        const snapshot = await client.readCourse(course.courseId);
        report.push({
          key: course.key,
          course: snapshot.course.displayName,
          ...(await countCourse({ client, courseId: course.courseId, snapshot })),
        });
      } catch (error) {
        // One course refusing is not the run failing, for the reason `src/courses.mjs` gives: the
        // count is per course, and twelve answers with one gap beat no answer at all.
        report.push({ key: course.key, unreadable: error.message });
      }
    }
  } finally {
    await client.close();
  }

  await writeLine(stdout, JSON.stringify({ courses: report }, null, 2));
  return 0;
}

const status = await main(process.argv.slice(2)).catch(async (error) => {
  await writeLine(stderr, error.message);
  return 1;
});

process.exit(status);
