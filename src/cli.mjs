import { spawn } from "node:child_process";
import { capabilityIndex } from "./capabilities/index.mjs";
import { runRepositoryChecks } from "./capabilities/check.mjs";
import { localHealth } from "./capabilities/health.mjs";
import { localStatus } from "./capabilities/status.mjs";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { loadConfig, selectCourses } from "./config.mjs";
import { diagnosticAddress } from "./ntulearn/sign-in.mjs";
import { walkCourses } from "./courses.mjs";
import { discoverContentRecordings } from "./media/discovery.mjs";
import { discoverCourseMedia } from "./media/workflow.mjs";
import { readMediaQueue, writeMediaQueue } from "./media/queue.mjs";
import { writeMediaCourseStatus } from "./media/status.mjs";
import { writeLine } from "./output.mjs";
import { setupMediaRuntime } from "./media/setup.mjs";
import { MEDIA_RUN_MODES } from "./media/worker.mjs";
import { readState, writeState } from "./sync/state.mjs";
import { runWatchdog, runWatchdogLocked } from "./watchdog/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const USAGE =
  "Usage: npm run login | npm run discover | npm run watchdog | npm run (sync|verify|renumber) -- <course|all> | npm run media:setup | npm run media:worker -- <scheduled|manual> | npm run media:discover -- <course|all> | npm run media:withdraw -- <course> <recordingId> confirm | npm run (capabilities|health|status|check)";

const commands = {
  login,
  discover,
  sync,
  verify,
  renumber,
  watchdog,
  "media-setup": mediaSetup,
  "media-worker": mediaWorker,
  "media-discover": mediaDiscover,
  "media-withdraw": mediaWithdraw,
  "watchdog-locked": watchdogLocked,
};

async function login(config) {
  const { openLoginWindow } = await import("./ntulearn/session.mjs");
  const window = await openLoginWindow(config.profilePath);
  try {
    await writeLine(stdout, "Complete NTU SSO/MFA in Chrome, then return here.");
    const prompt = createInterface({ input: stdin, output: stdout });
    await prompt.question("Press Enter after the NTULearn Courses page appears... ");
    prompt.close();
    await writeLine(stdout, `Session page: ${diagnosticAddress(window.page.url())}`);
  } finally {
    await window.close();
  }
  return 0;
}

async function discover(config) {
  const { openClient } = await import("./ntulearn/client.mjs");
  const client = await openClient(config.profilePath);
  try {
    await writeLine(stdout, asJson(await client.listCourses()));
  } finally {
    await client.close();
  }
  return 0;
}

async function sync(config, key) {
  const { syncCourse } = await import("./sync/course.mjs");
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
  const { verifyCourse, verifyReport } = await import("./sync/verify.mjs");
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

async function mediaWorker(config, mode = "scheduled") {
  if (!MEDIA_RUN_MODES.includes(mode)) {
    throw new Error("Usage: npm run media:worker -- <scheduled|manual>");
  }
  const { runProductionMedia } = await import("./media/production.mjs");
  const result = await runProductionMedia({ config, mode, timeZone: "Asia/Singapore" });
  await writeLine(stdout, asJson(result.digest));
  return result.exitCode;
}

async function mediaDiscover(config, key) {
  const { courses, refused } = await eachCourse(config, key, async ({ client, course }) => {
    const discovery = await discoverCourseMedia({ client, course });
    if (!discovery.skipped) {
      const saved = await writeMediaQueue({
        statePath: config.statePath,
        course,
        discovery,
      });
      discovery.queuePath = saved.path;
    } else {
      const status = await writeMediaCourseStatus({ course, discovery });
      if (status) discovery.statusPath = status.path;
    }
    return discovery;
  });
  await writeLine(stdout, asJson({ courses, ...(refused.length ? { refused } : {}) }));
  return courses.some((course) => course.complete === false) ? 1 : 0;
}

async function mediaWithdraw(config, key, recordingId, confirmation) {
  if (!key || key.toLowerCase() === "all" || !recordingId || confirmation !== "confirm") {
    throw new Error("Usage: npm run media:withdraw -- <course> <recordingId> confirm");
  }
  const course = selectCourses(config.courses, key)[0];
  const loaded = await readMediaQueue({
    statePath: config.statePath,
    courseKey: course.key,
    course,
  });
  if (!loaded.record || !Array.isArray(loaded.record.queue)) {
    throw new Error(
      `No durable media queue exists for ${course.key}. Run: npm run media:discover -- ${course.key}`,
    );
  }
  const saved = await writeMediaQueue({
    statePath: config.statePath,
    course,
    discovery: loaded.record,
    withdrawal: { recordingId, confirmed: true },
  });
  await writeLine(
    stdout,
    asJson({ courseKey: course.key, recordingId, status: saved.status, queuePath: saved.path }),
  );
  return saved.status === "not-found" ? 1 : 0;
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
  const { renumberCourse, renumberReport } = await import("./sync/renumber.mjs");
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
  const { openClient } = await import("./ntulearn/client.mjs");
  const client = await openClient(config.profilePath);

  try {
    return await walkCourses({ client, courses, walk });
  } finally {
    await client.close();
  }
}

async function main([name, ...argumentsForCommand]) {
  if (["capabilities", "check", "health", "status"].includes(name)) {
    return offlineCommand(name, argumentsForCommand);
  }
  const command = commands[name];
  if (!command) {
    await writeLine(stderr, USAGE);
    return 1;
  }
  return command(await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH), ...argumentsForCommand);
}

async function offlineCommand(name, argumentsForCommand) {
  if (argumentsForCommand.length > (name === "capabilities" || name === "check" ? 1 : 0)) {
    await writeLine(
      stdout,
      asJson({
        schemaVersion: 1,
        command: name,
        status: "blocked",
        exitCode: 2,
        checks: [
          {
            id: "arguments",
            status: "blocked",
            code: "USAGE",
            message: "Unexpected arguments.",
            action: `Run: npm run ${name}`,
            evidence: {},
          },
        ],
        evidence: {},
      }),
    );
    return 2;
  }
  let result;
  if (name === "capabilities") {
    try {
      result = capabilityIndex(argumentsForCommand[0]);
    } catch {
      await writeLine(
        stdout,
        asJson({
          schemaVersion: 1,
          command: name,
          status: "blocked",
          exitCode: 2,
          checks: [
            {
              id: "selection",
              status: "blocked",
              code: "UNKNOWN_CAPABILITY",
              message: "Unknown capability.",
              action: "Run: npm run capabilities",
              evidence: {},
            },
          ],
          evidence: {},
        }),
      );
      return 2;
    }
  } else if (name === "check") {
    result = await runRepositoryChecks({
      root: ROOT,
      selection: argumentsForCommand[0],
      node: process.execPath,
      run: checkRunner,
    });
  } else {
    const options = {
      root: ROOT,
      configPath: process.env.NTULEARN_CONFIG_PATH,
      nodeVersion: process.versions.node,
    };
    result = await (name === "health" ? localHealth(options) : localStatus(options));
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode ?? 0;
}

function checkRunner(command, argumentsFor, { cwd, timeout }) {
  return new Promise((done) => {
    const child = spawn(command, argumentsFor, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const parts = { stdout: "", stderr: "" };
    let timedOut = false;
    let stopped = false;
    const stop = () => {
      if (!stopped) {
        stopped = true;
        if (child.pid) killProcessGroup(child.pid);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    for (const key of ["stdout", "stderr"])
      child[key].on("data", (chunk) => {
        parts[key] += chunk.toString();
        if (parts[key].length > 2 * 1024 * 1024) stop();
      });
    child.once("error", () => {
      clearTimeout(timer);
      done({ exitCode: 1, ...parts, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code ?? 1, ...parts, timedOut });
    });
  });
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
