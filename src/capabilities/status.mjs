import { dirname, join } from "node:path";
import { isValidImportStatus, IMPORT_STATUS_FILENAME } from "../sync/import-status.mjs";
import { readLocalConfig } from "./health.mjs";
import { readEvidence } from "./read.mjs";
import { capabilityResult, observation } from "./result.mjs";

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export async function localStatus({
  root,
  configPath,
  load,
  read = readEvidence,
  now = () => new Date(),
}) {
  const loaded = await readLocalConfig(root, configPath, load);
  if (!loaded.config) return capabilityResult("status", [loaded.check]);
  const config = loaded.config;
  const observedAt = now();
  const receipts = {
    complete: 0,
    partial: 0,
    failed: 0,
    running: 0,
    missing: 0,
    invalid: 0,
    stale: 0,
  };
  for (const course of config.courses) {
    const receipt = await read(join(course.destination, IMPORT_STATUS_FILENAME), 16 * 1024);
    if (receipt.status === "blocked") receipts.missing += 1;
    else if (
      receipt.status !== "passed" ||
      !isValidImportStatus(receipt.value, observedAt.toISOString())
    )
      receipts.invalid += 1;
    else {
      receipts[receipt.value.status] += 1;
      if (stale(receipt.value.finishedAt ?? receipt.value.startedAt, observedAt))
        receipts.stale += 1;
    }
  }
  const receiptStatus =
    receipts.invalid || receipts.failed || receipts.partial
      ? "failed"
      : receipts.missing || receipts.running || receipts.stale
        ? "blocked"
        : "passed";
  const checks = [
    observation(
      "sync-receipts",
      receiptStatus,
      receiptStatus === "passed" ? "SYNC_RECEIPTS_COMPLETE" : "SYNC_RECEIPTS_INCOMPLETE",
      "Observed receipt lifecycle; a running receipt may be active or interrupted.",
      receiptStatus === "passed"
        ? null
        : "Owner: inspect local receipts and authorize sync only after health passes.",
      receipts,
    ),
  ];
  const stateRoot = dirname(config.statePath);
  checks.push(
    await digestObservation("watchdog-digest", join(stateRoot, "latest.json"), read, observedAt),
  );
  return capabilityResult("status", checks, {
    observedAt: observedAt.toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    scope: "local-operational-evidence",
    upstreamCompleteness: "unrun",
    artifactBytes: "unrun",
  });
}

async function digestObservation(id, path, read, observedAt) {
  const result = await read(path);
  if (result.status !== "passed")
    return observation(
      id,
      result.status,
      result.code,
      "Local digest missing or unreadable; no success inferred.",
      "Owner: inspect local run evidence before authorizing another run.",
    );
  const value = result.value;
  if (
    !value ||
    !["green", "yellow", "red"].includes(value.verdict) ||
    !validTime(value.timestamp, observedAt)
  )
    return observation(
      id,
      "failed",
      "DIGEST_INVALID",
      "Digest verdict/time invalid; no raw logs exposed.",
      "Inspect the producer and local digest; report a reproducible defect.",
    );
  const old = stale(value.timestamp, observedAt);
  const status =
    value.verdict === "red" ? "failed" : old || value.verdict === "yellow" ? "blocked" : "passed";
  return observation(
    id,
    status,
    old ? "DIGEST_STALE" : `DIGEST_${value.verdict.toUpperCase()}`,
    "Digest is a bounded run observation, separate from sync completeness.",
    status === "passed"
      ? null
      : "Owner: inspect the referenced private run log; live retries require approval.",
    { verdict: value.verdict, timestamp: value.timestamp, stale: old },
  );
}

function validTime(value, observedAt) {
  if (typeof value !== "string") return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value && time <= observedAt;
}

function stale(value, observedAt) {
  return observedAt.getTime() - Date.parse(value) > STALE_AFTER_MS;
}
