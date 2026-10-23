import { Buffer, isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { clearTimeout, setTimeout as schedule } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { INITIAL_WATCHDOG_TIMEOUT_MS } from "../config.mjs";
import { isDirectoryPresent, writeAtomically } from "../sync/files.mjs";
import { isCrashOrTimeout, sessionLapsed, watchdogVerdict } from "./verdict.mjs";

const LOCK_HELD = 75;
const MAX_DIGEST_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15 * 60 * 1000;

export async function runWatchdog({ config, root, runner }) {
  const paths = watchdogPaths(config.statePath);
  await mkdir(paths.stateDirectory, { recursive: true });

  const preCheck = await destinationReadinessCheck(config);
  if (!preCheck.ready) {
    const timestamp = new Date();
    const run = buildRun({
      startedAt: timestamp,
      finishedAt: timestamp,
      attempts: 0,
      timeoutMs: timeoutFor(config),
      preChecks: preChecksFor(preCheck, [{ attempt: 0, ...preCheck }]),
      attemptResults: [],
      sync: null,
      verify: null,
    });
    const digest = await writeDigest(paths, run);
    return { digest, exitCode: 1 };
  }

  const result = await runWithLock({ root, runner, lockPath: paths.lockPath });
  if (result.code === LOCK_HELD && result.signal === null) {
    const digest = await writeSkippedDigest(paths, timeoutFor(config));
    return { digest, exitCode: 0 };
  }

  return currentChildResult(result);
}

export async function runWatchdogLocked({ config, root, runner, wait = sleep }) {
  const startedAt = new Date();
  const preCheckHistory = [];
  const attemptResults = [];
  let lastAttempt = { sync: null, verify: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const destinationReadiness = await destinationReadinessCheck(config);
    preCheckHistory.push({ attempt, ...destinationReadiness });
    if (!destinationReadiness.ready) break;

    const result = await runAttempt({ config, root, runner, timeoutMs: timeoutFor(config) });
    lastAttempt = result;
    attemptResults.push({ attempt, ...result });

    if (attempt === MAX_ATTEMPTS || !shouldRetry(result)) break;
    await wait(RETRY_DELAY_MS);
  }

  const finishedAt = new Date();
  const latestPreCheck = preCheckHistory.at(-1) ?? null;
  const run = buildRun({
    startedAt,
    finishedAt,
    attempts: attemptResults.length,
    timeoutMs: timeoutFor(config),
    preChecks: preChecksFor(latestPreCheck, preCheckHistory),
    attemptResults,
    sync: lastAttempt.sync,
    verify: lastAttempt.verify,
  });
  return writeDigest(watchdogPaths(config.statePath), run);
}

function watchdogPaths(statePath) {
  const stateDirectory = dirname(resolve(statePath));
  return {
    stateDirectory,
    logsDirectory: join(stateDirectory, "logs"),
    latestPath: join(stateDirectory, "latest.json"),
    lockPath: join(stateDirectory, "watchdog.lock"),
  };
}

async function runAttempt({ config, root, runner, timeoutMs }) {
  const timeoutAt = Date.now() + timeoutMs;
  const sync = classifyDestinationPermission(
    await captureCommand({ root, runner, command: "sync", timeoutAt }),
    config.courses ?? [],
  );
  if (isCrashOrTimeout(sync)) return { sync, verify: null };

  const verify = classifyDestinationPermission(
    await captureCommand({ root, runner, command: "verify", timeoutAt }),
    config.courses ?? [],
  );
  return { sync, verify };
}

function classifyDestinationPermission(command, courses) {
  const match = command.stderr?.match(/\b(EACCES|EPERM)\b[^\n]*?['"]([^'"]+)['"]/i);
  if (!match) return command;

  const deniedPath = resolve(match[2]);
  const course = courses.find(({ destination }) => pathsOverlap(destination, deniedPath));
  if (!course) return command;
  return {
    ...command,
    destinationPermission: {
      code: match[1].toUpperCase(),
      destination: course.destination,
      path: deniedPath,
    },
  };
}

function pathsOverlap(left, right) {
  const comparableLeft = resolve(left).toLowerCase();
  const comparableRight = resolve(right).toLowerCase();
  return (
    comparableLeft === comparableRight ||
    comparableLeft.startsWith(`${comparableRight}${sep}`) ||
    comparableRight.startsWith(`${comparableLeft}${sep}`)
  );
}

async function destinationReadinessCheck(config) {
  const mountPresent = Boolean(
    config.driveMountPath && (await isDirectoryPresent(config.driveMountPath)),
  );
  const destinations = mountPresent
    ? await Promise.all(
        (config.courses ?? []).map(async (course) => {
          const root = destinationDriveRoot(config.driveMountPath, course.destination);
          return {
            path: course.destination,
            root,
            present:
              destinationRelation(config.driveMountPath, course.destination).inside &&
              (await isDirectoryPresent(root)),
          };
        }),
      )
    : [];
  return {
    ready: mountPresent && destinations.every((destination) => destination.present),
    driveMount: { path: config.driveMountPath, present: mountPresent },
    destinations,
  };
}

function destinationDriveRoot(driveMountPath, destination) {
  const { inside, pathFromMount } = destinationRelation(driveMountPath, destination);
  if (!inside) return driveMountPath;
  if (!pathFromMount) return driveMountPath;
  return join(driveMountPath, pathFromMount.split(sep)[0]);
}

function destinationRelation(driveMountPath, destination) {
  const pathFromMount = relative(driveMountPath, destination);
  const inside =
    !isAbsolute(pathFromMount) && pathFromMount !== ".." && !pathFromMount.startsWith(`..${sep}`);
  return { inside, pathFromMount };
}

function preChecksFor(destinationReadiness, history) {
  if (!destinationReadiness) return { history };
  const { driveMount, destinations } = destinationReadiness;
  return { driveMount, destinations, history };
}

async function runWithLock({ root, runner, lockPath }) {
  const { command, argumentsFor } = runner.lock(lockPath);
  try {
    return await new Promise((resolveResult, reject) => {
      const child = runner.spawn(command, argumentsFor, {
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const chunks = [];
      let bytes = 0;
      let failure = null;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_DIGEST_BYTES) chunks.push(chunk);
      });
      child.stdout.once("error", (error) => {
        failure ??= error;
      });
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code, signal) => {
        if (failure) reject(failure);
        else
          resolveResult({
            code,
            signal,
            stdout: Buffer.concat(chunks),
            oversized: bytes > MAX_DIGEST_BYTES,
          });
      });
    });
  } catch (error) {
    throw new Error(
      `Watchdog locked process could not run (${error.code ?? error.message}). Check the lock command and inspect this run's stderr before retrying.`,
      { cause: error },
    );
  }
}

function currentChildResult({ code, signal, stdout, oversized }) {
  const digest = !oversized && isUtf8(stdout) ? parseReport(stdout.toString("utf8")) : null;
  const verdict = code === 0 ? "green" : code === 1 ? "red" : null;
  const timestamp = new Date(typeof digest?.timestamp === "string" ? digest.timestamp : NaN);
  const logPath = typeof digest?.runLog === "string" ? digest.runLog.split(sep) : [];
  if (
    signal !== null ||
    !verdict ||
    digest?.verdict !== verdict ||
    typeof digest.message !== "string" ||
    !digest.message.trim() ||
    typeof digest.timestamp !== "string" ||
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== digest.timestamp ||
    logPath[0] !== "logs" ||
    logPath.length !== 2 ||
    !logPath[1].endsWith(".json") ||
    logPath.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  ) {
    const ending = signal ? `stopped by ${signal}` : `exited ${code ?? "without a status"}`;
    throw new Error(
      `Watchdog locked process ${ending} without a valid digest. Inspect this run's stderr or the configured launchd stderr log before retrying.`,
    );
  }
  return { digest, exitCode: code };
}

function captureCommand({ root, runner, command, timeoutAt }) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = runner.spawn(runner.node, runner.argumentsFor(command), {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = runner.killProcessGroup;
    let stdout = "";
    let stderr = "";
    let failed = false;
    let timedOut = false;

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      failed = true;
      stderr += `${error.message}\n`;
      clearTimeout(timeout);
    });
    child.once("close", (code, signal) => finish(failed ? null : code, failed ? null : signal));

    const remaining = Math.max(0, timeoutAt - Date.now());
    const timeout = schedule(() => {
      timedOut = true;
      killGroup(child.pid);
    }, remaining);

    function finish(exitCode, signal) {
      clearTimeout(timeout);
      const report = parseReport(stdout);
      resolveResult({
        command,
        exitCode: timedOut ? 1 : (exitCode ?? 1),
        signal: timedOut ? "SIGKILL" : signal,
        timedOut,
        crashed: !timedOut && report === null,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        report,
      });
    }
  });
}

async function writeSkippedDigest(paths, timeoutMs) {
  const timestamp = new Date();
  const run = buildRun({
    startedAt: timestamp,
    finishedAt: timestamp,
    attempts: 0,
    timeoutMs,
    preChecks: { lockHeld: true },
    attemptResults: [],
    sync: null,
    verify: null,
  });
  return writeDigest(paths, run);
}

function buildRun({
  startedAt,
  finishedAt,
  attempts,
  timeoutMs,
  preChecks,
  attemptResults,
  sync,
  verify,
}) {
  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    attempts,
    preChecks,
    attemptResults,
    sync,
    verify,
    verdict: watchdogVerdict({ sync, verify, preChecks, attempts, attemptResults }),
  };
}

async function writeDigest(paths, run) {
  const runLog = await writeRunLog(paths, run);
  const digest = { ...run.verdict, timestamp: run.finishedAt, runLog };
  await writeJson(paths.latestPath, digest);
  return digest;
}

async function writeRunLog(paths, run) {
  const timestamp = new Date(run.finishedAt);
  const filename = `${timestamp.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}.json`;
  const path = join(paths.logsDirectory, filename);
  await writeJson(path, run);
  return relative(paths.stateDirectory, path);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseReport(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function timeoutFor(config) {
  return config.watchdogTimeoutMs ?? INITIAL_WATCHDOG_TIMEOUT_MS;
}

function shouldRetry({ sync, verify }) {
  if ([sync, verify].some((command) => command?.destinationPermission)) return false;
  if ([sync, verify].some(sessionLapsed)) return false;
  return [sync, verify].some(isCrashOrTimeout);
}
