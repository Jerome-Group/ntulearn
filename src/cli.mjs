import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "./config.mjs";
import { walkCourses } from "./courses.mjs";
import { writeLine } from "./output.mjs";
import { openClient } from "./ntulearn/client.mjs";
import { openLoginWindow } from "./ntulearn/session.mjs";
import { syncCourse } from "./sync/course.mjs";
import { readState, writeState } from "./sync/state.mjs";
import { verifyCourse, verifyReport } from "./sync/verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "Usage: npm run login | npm run discover | npm run (sync|verify) -- <course|all>";

const commands = { login, discover, sync, verify };

async function login(config) {
  const window = await openLoginWindow(config.profilePath);
  try {
    await writeLine(stdout, "Complete NTU SSO/MFA in Chrome, then return here.");
    const prompt = createInterface({ input: stdin, output: stdout });
    await prompt.question("Press Enter after the NTULearn Courses page appears... ");
    prompt.close();
    await writeLine(stdout, `Session page: ${window.page.url()}`);
  } finally {
    await window.close();
  }
  return 0;
}

async function discover(config) {
  const client = await openClient(config.profilePath);
  try {
    await writeLine(stdout, asJson(await client.listCourses()));
  } finally {
    await client.close();
  }
  return 0;
}

async function sync(config, key) {
  const state = await readState(config.statePath);
  const { courses, refused } = await eachCourse(config, key, async ({ client, course }) => {
    const result = await syncCourse({ client, course, state });
    await writeState(config.statePath, state);
    return result;
  });

  await writeLine(stdout, asJson({ courses, ...(refused.length ? { refused } : {}) }));
  return courses.some((course) => course.failures.length) ? 1 : 0;
}

async function verify(config, key) {
  const { courses, refused } = await eachCourse(config, key, verifyCourse);
  const report = verifyReport(courses, refused);

  await writeLine(stdout, asJson(report));
  if (report.complete) return 0;

  await writeLine(stderr, `Files are absent. Run: npm run sync -- ${key || "all"}`);
  return 1;
}

// One session serves every course asked for, and it is closed whether or not the walk finishes.
async function eachCourse(config, key, walk) {
  const courses = selectCourses(config.courses, key);
  const client = await openClient(config.profilePath);

  try {
    return await walkCourses({ client, courses, walk });
  } finally {
    await client.close();
  }
}

async function main([name, argument]) {
  const command = commands[name];
  if (!command) {
    await writeLine(stderr, USAGE);
    return 1;
  }
  return command(await loadConfig(ROOT), argument);
}

function asJson(value) {
  return JSON.stringify(value, null, 2);
}

const status = await main(process.argv.slice(2)).catch(async (error) => {
  await writeLine(stderr, error.message);
  return 1;
});

// Chrome's persistent profile can leave handles open, so the exit is asked for rather than waited
// for. Every line above has been flushed by the time this runs.
process.exit(status);
