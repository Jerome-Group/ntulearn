import { spawn } from "node:child_process";
import { capabilityIndex } from "./capabilities/index.mjs";
import { runRepositoryChecks, parseCheckArguments } from "./capabilities/check.mjs";
import { createCheckCapture, CHECK_CAPTURE_BYTES } from "./capabilities/check-capture.mjs";
import { StringDecoder } from "node:string_decoder";
import { localHealth } from "./capabilities/health.mjs";
import { localStatus } from "./capabilities/status.mjs";
import { localLibrary, libraryFailure, LIBRARY_LIMITS } from "./library/catalogue.mjs";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { loadConfig, selectCourses } from "./config.mjs";
import { diagnosticAddress } from "./ntulearn/sign-in.mjs";
import { walkCourses } from "./courses.mjs";
import { writeLine } from "./output.mjs";
import { readState, writeState } from "./sync/state.mjs";
import { runWatchdog, runWatchdogLocked } from "./watchdog/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const USAGE =
  "Usage: npm run login | npm run discover | npm run watchdog | npm run (sync|verify|renumber) -- <course|all> | npm run (capabilities|health|status|check|library)";

const commands = {
  login,
  discover,
  sync,
  verify,
  renumber,
  watchdog,
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

async function watchdogLocked(config) {
  const digest = await runWatchdogLocked({ config, root: ROOT, runner: watchdogRunner() });
  await writeLine(stdout, asJson(digest));
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
  if (!report.blocked && !report.recoveries) return 0;

  await writeLine(
    stderr,
    `Renumber needs attention with ${report.blocked ?? 0} blocked moves and ${report.recoveries ?? 0} recovery claims. Follow each report reason; inspect and preserve retained claim bytes before retrying.`,
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
  if (name === "library") return libraryCommand(argumentsForCommand);
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

async function libraryCommand(args) {
  const options = { format: "json" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag) || !["--course", "--query", "--html"].includes(flag))
      return emitLibrary(
        libraryFailure(
          "USAGE",
          "Unknown or repeated library argument.",
          "Run: npm run library -- [--course <key>] [--query <text>] [--html]",
        ),
      );
    seen.add(flag);
    if (flag === "--html") options.format = "html";
    else {
      const value = args[++index];
      if (value === undefined || (flag === "--course" && !value))
        return emitLibrary(
          libraryFailure(
            "USAGE",
            "A library option needs a value.",
            "Run: npm run library -- [--course <key>] [--query <text>] [--html]",
          ),
        );
      options[flag === "--course" ? "course" : "query"] = value;
    }
  }
  if (Array.from(options.query ?? "").length > LIBRARY_LIMITS.queryCodePoints)
    return emitLibrary(
      libraryFailure(
        "QUERY_LIMIT",
        "The search query exceeds 256 characters.",
        "Use at most 256 Unicode code points in a query.",
        options.format,
      ),
    );
  let config;
  try {
    config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
  } catch {
    return emitLibrary(
      libraryFailure(
        "CONFIG_UNAVAILABLE",
        "Private configuration is missing, invalid, or inaccessible.",
        "Copy config/courses.example.json to a private configuration and check its course directories.",
        options.format,
      ),
    );
  }
  return emitLibrary(await localLibrary(config, options));
}

async function emitLibrary(result) {
  await writeLine(stdout, result.source);
  return result.exitCode;
}

async function offlineCommand(name, argumentsForCommand) {
  const checkArguments = name === "check" ? parseCheckArguments(argumentsForCommand) : null;
  if (
    name === "check"
      ? !checkArguments
      : argumentsForCommand.length > (name === "capabilities" ? 1 : 0)
  ) {
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
      ...checkArguments,
      node: process.execPath,
      run: checkRunner,
      evidenceOptions: { ownerUid: process.getuid?.() },
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

function checkRunner(command, argumentsFor, { cwd, timeout, retainOutput = false }) {
  return new Promise((done) => {
    const child = spawn(command, argumentsFor, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const streams = Object.fromEntries(
      ["stdout", "stderr"].map((key) => [
        key,
        { decoder: new StringDecoder("utf8"), output: "", bytes: 0 },
      ]),
    );
    const capture = retainOutput ? createCheckCapture() : null;
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
        capture?.append(key, chunk);
        const stream = streams[key],
          remaining = Math.max(0, CHECK_CAPTURE_BYTES - stream.bytes);
        stream.output += stream.decoder.write(chunk.subarray(0, remaining));
        stream.bytes += chunk.length;
        if (stream.bytes > CHECK_CAPTURE_BYTES) stop();
      });
    child.once("error", () => {
      clearTimeout(timer);
      stop();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Object.fromEntries(
        Object.entries(streams).map(([key, stream]) => [
          key,
          stream.output + (stream.bytes <= CHECK_CAPTURE_BYTES ? stream.decoder.end() : ""),
        ]),
      );
      done({
        exitCode: stopped ? 1 : (code ?? 1),
        ...output,
        timedOut,
        ...(capture ? { rawOutput: capture.result() } : {}),
      });
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
