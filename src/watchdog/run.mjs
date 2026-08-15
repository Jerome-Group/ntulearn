import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeAtomically } from "../sync/files.mjs";
import { watchdogVerdict } from "./verdict.mjs";

const LOCK_HELD = 75;

export async function runWatchdog({ config, root, runner }) {
  const paths = watchdogPaths(config.statePath);
  await mkdir(paths.stateDirectory, { recursive: true });

  const result = await runWithLock({ root, runner, lockPath: paths.lockPath });
  if (result.code === LOCK_HELD) {
    const digest = await writeSkippedDigest(paths);
    return { digest, exitCode: 0 };
  }

  const digest = await readJson(paths.latestPath);
  if (!digest) throw new Error("Watchdog did not write latest.json. Run: npm run watchdog.");
  return { digest, exitCode: result.code ?? 1 };
}

export async function runWatchdogLocked({ config, root, runner }) {
  const paths = watchdogPaths(config.statePath);
  const startedAt = new Date();
  const sync = await captureCommand({ root, runner, command: "sync" });
  const verify = await captureCommand({ root, runner, command: "verify" });
  const finishedAt = new Date();
  const run = buildRun({
    startedAt,
    finishedAt,
    attempts: 1,
    preChecks: {},
    sync,
    verify,
  });
  return writeDigest(paths, run);
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

function captureCommand({ root, runner, command }) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = runner.spawn(runner.node, runner.argumentsFor(command), {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(null, null, `${error.message}\n`));
    child.once("close", (code, signal) => finish(code, signal, stderr));

    function finish(exitCode, signal, errorOutput) {
      if (settled) return;
      settled = true;
      resolveResult({
        command,
        exitCode: exitCode ?? 1,
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr: errorOutput,
        report: parseReport(stdout),
      });
    }
  });
}

async function writeSkippedDigest(paths) {
  const timestamp = new Date();
  const run = buildRun({
    startedAt: timestamp,
    finishedAt: timestamp,
    attempts: 0,
    preChecks: { lockHeld: true },
    sync: null,
    verify: null,
  });
  return writeDigest(paths, run);
}

function buildRun({ startedAt, finishedAt, attempts, preChecks, sync, verify }) {
  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    attempts,
    preChecks,
    sync,
    verify,
    verdict: watchdogVerdict({ sync, verify, preChecks, attempts }),
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
