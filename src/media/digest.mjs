import { join, relative, dirname, resolve } from "node:path";
import { writeAtomically } from "../atomic.mjs";

export function mediaDigestPaths(statePath) {
  const stateDirectory = dirname(resolve(statePath));
  return {
    stateDirectory,
    logsDirectory: join(stateDirectory, "media-logs"),
    latestPath: join(stateDirectory, "media-latest.json"),
  };
}

export async function persistMediaDigest({
  statePath,
  runId,
  mode,
  startedAt,
  finishedAt,
  courses,
  counts,
  globalStop,
  stoppedAtBoundary,
  verdict,
  message,
  summarizeCounts,
  write = writeAtomically,
}) {
  assertRunId(runId);
  const paths = mediaDigestPaths(statePath);
  const run = {
    version: 1,
    runId,
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    globalStop,
    stoppedAtBoundary,
    verdict,
    message,
    courses,
    ...(counts ? { counts } : { counts: summarizeCounts(courses) }),
  };
  const logPath = join(paths.logsDirectory, `${safeTimestamp(finishedAt)}-${runId}.json`);
  const runLog = relative(paths.stateDirectory, logPath);
  const digest = {
    version: 1,
    runId,
    mode,
    verdict,
    message,
    timestamp: run.finishedAt,
    runLog,
    counts: run.counts,
    globalStop,
    stoppedAtBoundary,
  };
  await write(logPath, `${JSON.stringify(run, null, 2)}\n`);
  await write(paths.latestPath, `${JSON.stringify(digest, null, 2)}\n`);
  return digest;
}

function safeTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Media run id must be a safe filename component.");
  }
}
