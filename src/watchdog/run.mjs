import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { clearTimeout, setTimeout as schedule } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join, relative, resolve } from "node:path";
import { INITIAL_WATCHDOG_TIMEOUT_MS } from "../config.mjs";
import { isDirectoryPresent, writeAtomically } from "../sync/files.mjs";
import { isCrashOrTimeout, sessionLapsed, watchdogVerdict } from "./verdict.mjs";

const LOCK_HELD = 75;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15 * 60 * 1000;

export async function runWatchdog({ config, root, runner }) {
  const paths = watchdogPaths(config.statePath);
  await mkdir(paths.stateDirectory, { recursive: true });

  const preCheck = await driveMountCheck(config);
  if (!preCheck.present) {
    const timestamp = new Date();
    const run = buildRun({
      startedAt: timestamp,
      finishedAt: timestamp,
      attempts: 0,
      timeoutMs: timeoutFor(config),
      preChecks: preChecksFor(preCheck, [{ attempt: 0, driveMount: preCheck }]),
      attemptResults: [],
      sync: null,
      verify: null,
    });
    const digest = await writeDigest(paths, run);
    return { digest, exitCode: 1 };
  }

  const result = await runWithLock({ root, runner, lockPath: paths.lockPath });
  if (result.code === LOCK_HELD) {
    const digest = await writeSkippedDigest(paths, timeoutFor(config));
    return { digest, exitCode: 0 };
  }

  const digest = await readJson(paths.latestPath);
  if (!digest) throw new Error("Watchdog did not write latest.json. Run: npm run watchdog.");
  return { digest, exitCode: result.code ?? 1 };
}

export async function runWatchdogLocked({ config, root, runner, wait = sleep }) {
  const startedAt = new Date();
  const preCheckHistory = [];
  const attemptResults = [];
  let lastAttempt = { sync: null, verify: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const driveMount = await driveMountCheck(config);
    preCheckHistory.push({ attempt, driveMount });
    if (!driveMount.present) break;

    const result = await runAttempt({ root, runner, timeoutMs: timeoutFor(config) });
    lastAttempt = result;
    attemptResults.push({ attempt, ...result });

    if (attempt === MAX_ATTEMPTS || !shouldRetry(result)) break;
    await wait(RETRY_DELAY_MS);
  }

  const finishedAt = new Date();
  const latestPreCheck = preCheckHistory.at(-1)?.driveMount ?? null;
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

async function runAttempt({ root, runner, timeoutMs }) {
  const timeoutAt = Date.now() + timeoutMs;
  const sync = await captureCommand({ root, runner, command: "sync", timeoutAt });
  if (isCrashOrTimeout(sync)) return { sync, verify: null };

  const verify = await captureCommand({ root, runner, command: "verify", timeoutAt });
  return { sync, verify };
}

async function driveMountCheck(config) {
  return {
    path: config.driveMountPath,
    present: Boolean(config.driveMountPath && (await isDirectoryPresent(config.driveMountPath))),
  };
}

function preChecksFor(driveMount, history) {
  return { driveMount, history };
}

async function runWithLock({ root, runner, lockPath }) {
  const { command, argumentsFor } = runner.lock(lockPath);
  return new Promise((resolveResult, reject) => {
    const child = runner.spawn(command, argumentsFor, {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
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
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(null, null, `${stderr}${error.message}\n`));
    child.once("close", (code, signal) => finish(code, signal, stderr));

    const remaining = Math.max(0, timeoutAt - Date.now());
    const timeout = schedule(() => {
      killGroup(child.pid);
      finish(1, "SIGKILL", stderr, true);
    }, remaining);

    function finish(exitCode, signal, errorOutput, timedOut = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const report = parseReport(stdout);
      resolveResult({
        command,
        exitCode: exitCode ?? 1,
        signal,
        timedOut,
        crashed: !timedOut && report === null,
        durationMs: Date.now() - started,
        stdout,
        stderr: errorOutput,
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

async function readJson(path) {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return raw === null ? null : JSON.parse(raw);
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
  if ([sync, verify].some(sessionLapsed)) return false;
  return [sync, verify].some(isCrashOrTimeout);
}
