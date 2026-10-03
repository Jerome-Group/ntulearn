import { spawn } from "node:child_process";
import { capabilityIndex } from "./capabilities/index.mjs";
import { capabilityResult, observation } from "./capabilities/result.mjs";
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
import { withMediaQueueLock } from "./media/lock.mjs";
import { writeMediaCourseStatus } from "./media/status.mjs";
import { writeLine } from "./output.mjs";
import { setupMediaRuntime } from "./media/setup.mjs";
import { MEDIA_RUN_MODES } from "./media/worker.mjs";
import { readState, writeState } from "./sync/state.mjs";
import { runWatchdog, runWatchdogLocked } from "./watchdog/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const USAGE =
  "Usage: npm run login | npm run discover | npm run watchdog | npm run (sync|verify|renumber) -- <course|all> | npm run media:setup | npm run media:worker -- <scheduled|manual> [priority-course (manual only)] | npm run media:discover -- <course|all> | npm run media:retry -- <plan|apply> <course|all> <failed|recordingId> [RETRY_FAILED_MEDIA] | npm run media:withdraw -- <course> <recordingId> confirm | npm run media:format -- <plan|apply|verify> <private-manifest> | npm run media:evaluate -- <plan|run> <manifest> [fresh-output-directory] | npm run media:recover -- <plan|run|publish> <private-manifest> [private-candidate-directory] [RECOVER_TRANSCRIPT_SOURCES|PUBLISH_RECOVERED_EDITIONS] | npm run media:catalogue -- <inspect|plan|publish|verify> [private-manifest] [private-selection-file|PUBLISH_TRANSCRIPT_CATALOGUE] | npm run (capabilities|health|status|check)";

const commands = {
  login,
  discover,
  sync,
  verify,
  renumber,
  watchdog,
  "media-setup": mediaSetup,
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
  const result = await setupMediaRuntime(config.media, {
    signalProcessGroup: signalMediaProcessGroup,
  });
  await writeLine(
    stdout,
    asJson({ manifestPath: result.manifestPath, artifacts: result.artifacts }),
  );
  return 0;
}

async function mediaWorker([mode = "scheduled", priorityCourseKey = null, ...unexpected]) {
  const controller = new globalThis.AbortController();
  const interrupt = () =>
    controller.abort(
      Object.assign(
        new Error("Media queue interrupted; inspect the run log and retry the manual worker."),
        { code: "MEDIA_INTERRUPTED" },
      ),
    );
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (
      !MEDIA_RUN_MODES.includes(mode) ||
      unexpected.length ||
      (priorityCourseKey !== null && mode !== "manual")
    ) {
      throw new Error(
        "Usage: npm run media:worker -- <scheduled|manual> [priority-course (manual only)]",
      );
    }
    const config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
    const { runProductionMedia } = await import("./media/production.mjs");
    const result = await runProductionMedia({
      config,
      mode,
      priorityCourseKey,
      signal: controller.signal,
      timeZone: "Asia/Singapore",
      signalProcessGroup: signalMediaProcessGroup,
    });
    await writeLine(stdout, asJson(result.digest));
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function mediaDiscover(config, key) {
  return withMediaQueueLock({
    statePath: config.statePath,
    run: async () => {
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
    },
  });
}

async function mediaRetry([mode, courseKey, selector, confirmation, ...unexpected]) {
  let result;
  if (
    !["plan", "apply"].includes(mode) ||
    !courseKey ||
    !selector ||
    unexpected.length ||
    (mode === "plan" && confirmation !== undefined)
  ) {
    result = capabilityResult("media:retry", [
      observation(
        "arguments",
        "blocked",
        "MEDIA_RETRY_ARGUMENTS",
        "Invalid explicit media retry arguments.",
        "Run: npm run media:retry -- <plan|apply> <course|all> <failed|recordingId> [RETRY_FAILED_MEDIA]",
      ),
    ]);
  } else {
    const { retryMediaJobs } = await import("./media/retry.mjs");
    let config;
    try {
      config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
    } catch {
      result = capabilityResult(
        "media:retry",
        [
          observation(
            "configuration",
            "blocked",
            "MEDIA_RETRY_CONFIG_UNAVAILABLE",
            "Private configuration or configured course roots could not be validated.",
            "Copy config/courses.example.json to the private configuration path, repair its JSON and restore accessible course folders; then run media:retry plan. No private error details exposed.",
          ),
        ],
        {
          mode,
          courses: 0,
          inspected: 0,
          selected: 0,
          alreadyRetryable: 0,
          changed: 0,
          retrySucceeded: "unrun",
          mediaCompleteness: "unclaimed",
        },
      );
    }
    if (config) result = await retryMediaJobs({ mode, config, courseKey, selector, confirmation });
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode;
}

async function mediaWithdraw(config, key, recordingId, confirmation) {
  if (!key || key.toLowerCase() === "all" || !recordingId || confirmation !== "confirm") {
    throw new Error("Usage: npm run media:withdraw -- <course> <recordingId> confirm");
  }
  const course = selectCourses(config.courses, key)[0];
  return withMediaQueueLock({
    statePath: config.statePath,
    run: async () => {
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
    },
  });
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

function signalMediaProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || ![0, "SIGTERM", "SIGKILL"].includes(signal)) {
    throw new Error(
      "Media cleanup needs an owned process-group PID and signal. Check the runtime composition before retrying.",
    );
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
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
  if (name === "media-retry") return mediaRetry(argumentsForCommand);
  if (name === "media-worker") return mediaWorker(argumentsForCommand);
  if (name === "media-catalogue") return mediaCatalogue(argumentsForCommand);
  if (name === "media-format") return mediaFormat(argumentsForCommand);
  if (name === "media-recover") return mediaRecover(argumentsForCommand);
  if (name === "media-evaluate") return mediaEvaluate(argumentsForCommand);
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

async function mediaCatalogue([mode, manifestPath, extra, ...unexpected]) {
  const controller = new globalThis.AbortController();
  const interrupt = () =>
    controller.abort(
      Object.assign(
        new Error("Catalogue interrupted; inspect retained journal and retry the same plan."),
        { code: "CATALOGUE_INTERRUPTED" },
      ),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let result;
  try {
    if (
      !["inspect", "plan", "publish", "verify"].includes(mode) ||
      unexpected.length ||
      (mode === "inspect" ? Boolean(manifestPath || extra) : !manifestPath) ||
      (mode === "publish"
        ? extra !== "PUBLISH_TRANSCRIPT_CATALOGUE"
        : mode !== "plan" && Boolean(extra))
    ) {
      result = capabilityResult("media:catalogue", [
        observation(
          "arguments",
          "blocked",
          "CATALOGUE_ARGUMENTS",
          "Invalid catalogue arguments or missing explicit publication token.",
          "Run npm run --silent capabilities -- transcript-catalogue for exact operations.",
        ),
      ]);
    } else {
      const config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
      const { transcriptCatalogue } = await import("./media/catalogue.mjs");
      result = await transcriptCatalogue({
        mode,
        config,
        manifestPath: manifestPath ? resolve(manifestPath) : undefined,
        selectionPath: mode === "plan" && extra ? resolve(extra) : undefined,
        signal: controller.signal,
      });
    }
  } catch {
    result = capabilityResult("media:catalogue", [
      observation(
        "configuration",
        "blocked",
        "CATALOGUE_CONFIG_UNAVAILABLE",
        "Private configuration could not be validated; details remain private.",
        "Repair private configuration and accessible storage, then retry catalogue inspect.",
      ),
    ]);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode;
}

async function mediaRecover([mode, manifestPath, outputDirectory, ...unexpected]) {
  const controller = new globalThis.AbortController();
  const interrupt = () =>
    controller.abort(
      Object.assign(
        new Error(
          "Recovery interrupted; inspect retained private candidates and retry with a fresh directory.",
        ),
        { code: "RECOVERY_INTERRUPTED" },
      ),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let result;
  try {
    if (
      !["plan", "run", "publish"].includes(mode) ||
      !manifestPath ||
      unexpected.length ||
      (mode === "plan" ? Boolean(outputDirectory) : !outputDirectory)
    ) {
      result = capabilityResult("media:recover", [
        observation(
          "arguments",
          "blocked",
          "RECOVERY_ARGUMENTS",
          "Invalid explicit source recovery arguments.",
          "Run: npm run --silent media:recover -- <plan|run|publish> <private-manifest> [candidate-directory]",
        ),
      ]);
    } else {
      const config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
      const { recoverTranscriptSources } = await import("./media/recovery.mjs");
      result = await recoverTranscriptSources({
        mode,
        manifestPath: resolve(manifestPath),
        outputDirectory: outputDirectory ? resolve(outputDirectory) : undefined,
        config,
        signalProcessGroup: signalMediaProcessGroup,
        signal: controller.signal,
      });
    }
  } catch {
    result = capabilityResult("media:recover", [
      observation(
        "configuration",
        "blocked",
        "RECOVERY_CONFIG_UNAVAILABLE",
        "Private recovery configuration could not be validated; no raw exception exposed.",
        "Repair private configuration and accessible storage, then retry media:recover plan.",
      ),
    ]);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode;
}

async function mediaFormat([mode, manifestPath, ...unexpected]) {
  const controller = new globalThis.AbortController();
  const interrupt = () =>
    controller.abort(
      new Error("Historical formatting interrupted; inspect private receipts and retry apply."),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let result;
  try {
    if (!["plan", "apply", "verify"].includes(mode) || !manifestPath || unexpected.length) {
      result = capabilityResult("media:format", [
        observation(
          "arguments",
          "blocked",
          "HISTORICAL_FORMAT_USAGE",
          "Invalid historical formatting arguments.",
          "Run: npm run media:format -- <plan|apply|verify> <private-manifest-path>",
        ),
      ]);
    } else {
      const { historicalTranscripts } = await import("./media/historical.mjs");
      const config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
      result = await historicalTranscripts({
        mode,
        manifestPath: resolve(manifestPath),
        config,
        signal: controller.signal,
      });
    }
  } catch {
    result = capabilityResult("media:format", [
      observation(
        "configuration",
        "failed",
        "HISTORICAL_FORMAT_FAILED",
        "Historical formatting did not execute; no raw exception exposed.",
        "Inspect local configuration and private input evidence, then retry plan.",
      ),
    ]);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode;
}

async function mediaEvaluate([mode, manifestPath, outputDirectory, ...unexpected]) {
  let result;
  const controller = new globalThis.AbortController();
  const interrupt = () =>
    controller.abort(
      new Error("Offline media evaluation interrupted. Retry in a fresh output directory."),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (
      !["plan", "run"].includes(mode) ||
      !manifestPath ||
      unexpected.length ||
      (mode === "plan" ? Boolean(outputDirectory) : !outputDirectory)
    ) {
      result = capabilityResult("media:evaluate", [
        observation(
          "arguments",
          "blocked",
          "EVALUATION_USAGE",
          "Invalid evaluation arguments.",
          "Run: npm run media:evaluate -- plan <manifest> or run <manifest> <fresh-output-directory>",
        ),
      ]);
    } else {
      const { planMediaEvaluation, runMediaEvaluation } = await import("./media/evaluation.mjs");
      if (mode === "plan") result = await planMediaEvaluation({ manifestPath });
      else {
        const config = await loadConfig(ROOT, process.env.NTULEARN_CONFIG_PATH);
        const { runMediaProcess } = await import("./media/process.mjs");
        const revisionOptions = {
          signal: controller.signal,
          signalProcessGroup: signalMediaProcessGroup,
          timeoutMs: 3_000,
          stdoutMaxBytes: 32 * 1024,
          stderrMaxBytes: 1024,
          label: "Evaluation code revision",
        };
        const checkout = await runMediaProcess(
          "git",
          ["-C", ROOT, "status", "--porcelain"],
          revisionOptions,
        ).catch(provenanceUnavailable);
        const revision =
          checkout?.stdout === ""
            ? await runMediaProcess("git", ["-C", ROOT, "rev-parse", "HEAD"], {
                ...revisionOptions,
                stdoutMaxBytes: 128,
              }).catch(provenanceUnavailable)
            : null;
        result = await runMediaEvaluation({
          manifestPath,
          outputDirectory,
          media: config.media,
          signalProcessGroup: signalMediaProcessGroup,
          signal: controller.signal,
          memoryMeasurement: process.platform === "darwin" ? "darwin-time" : null,
          codeRevision: revision?.stdout.trim() ?? null,
        });
      }
    }
  } catch (error) {
    result = capabilityResult("media:evaluate", [
      observation(
        "execution",
        "failed",
        error.code === "MEDIA_PROCESS_CLEANUP"
          ? "MEDIA_PROCESS_CLEANUP"
          : "EVALUATION_COMMAND_FAILED",
        error.globalSafety
          ? "Evaluation stopped on a process safety failure; no later work permitted."
          : "Evaluation could not execute; no raw exception exposed.",
        error.globalSafety
          ? "Stop media work, inspect the owned runtime processes, then retry in a fresh output directory."
          : "Check the private configuration, manifest and prepared runtime; retry plan before run.",
      ),
    ]);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  await writeLine(stdout, asJson(result));
  return result.exitCode;
}

function provenanceUnavailable(error) {
  if (error.globalSafety) throw error;
  return null;
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
