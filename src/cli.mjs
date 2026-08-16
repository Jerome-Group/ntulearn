import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "./config.mjs";
import { walkCourses } from "./courses.mjs";
import { discoverContentRecordings } from "./media/discovery.mjs";
import { writeLine } from "./output.mjs";
import { setupMediaRuntime } from "./media/setup.mjs";
import { openClient } from "./ntulearn/client.mjs";
import { openLoginWindow } from "./ntulearn/session.mjs";
import { syncCourse } from "./sync/course.mjs";
import { renumberCourse, renumberReport } from "./sync/renumber.mjs";
import { readState, writeState } from "./sync/state.mjs";
import { verifyCourse, verifyReport } from "./sync/verify.mjs";
import { runWatchdog, runWatchdogLocked } from "./watchdog/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const USAGE =
  "Usage: npm run login | npm run discover | npm run watchdog | npm run (sync|verify|renumber) -- <course|all> | npm run media:setup";

const commands = {
  login,
  discover,
  sync,
  verify,
  renumber,
  watchdog,
  "media-setup": mediaSetup,
  "watchdog-locked": watchdogLocked,
};

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
    const result = await syncCourse({
      client,
      course,
      state,
      recordingDiscovery: discoverContentRecordings,
    });
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

async function watchdog(config) {
  const result = await runWatchdog({ config, root: ROOT, runner: watchdogRunner() });
  await writeLine(stdout, asJson(result.digest));
  return result.exitCode;
}

async function mediaSetup(config) {
  const result = await setupMediaRuntime(config.media);
  await writeLine(
    stdout,
    asJson({ manifestPath: result.manifestPath, artifacts: result.artifacts }),
  );
  return 0;
}

async function watchdogLocked(config) {
  const digest = await runWatchdogLocked({ config, root: ROOT, runner: watchdogRunner() });
  return digest.verdict === "red" ? 1 : 0;
}

function watchdogRunner() {
  const lock =
    process.platform === "darwin"
      ? {
          command: "lockf",
          argumentsFor: (path) => ["-s", "-t", "0", "-k", path],
        }
      : {
          command: "flock",
          argumentsFor: (path) => ["-n", "-E", "75", path],
        };

  return {
    spawn,
    node: process.execPath,
    killProcessGroup,
    lock: (path) => ({
      command: lock.command,
      argumentsFor: [...lock.argumentsFor(path), process.execPath, CLI, "watchdog-locked"],
    }),
    argumentsFor: (command) => [CLI, command, "all"],
  };
}

function killProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// Its own command, run deliberately, because a rename is the one thing a sync will not do — and an
// unattended run at three in the morning is the worst place for it (ADR-0010). `State` is read for
// the digests and never written: the next sync finds each file at its new name and corrects the
// record itself.
async function renumber(config, key) {
  const state = await readState(config.statePath);
  const { courses, refused } = await eachCourse(config, key, ({ client, course }) =>
    renumberCourse({ client, course, state }),
  );
  const report = renumberReport(courses, refused);

  await writeLine(stdout, asJson(report));
  if (!report.blocked) return 0;

  await writeLine(
    stderr,
    `${report.blocked} could not be renumbered: the name each wants is held by something else.`,
  );
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
