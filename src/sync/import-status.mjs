import { Buffer } from "node:buffer";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomically } from "./files.mjs";

export const IMPORT_STATUS_FILENAME = "Sync status.json";

const MAX_RECEIPT_BYTES = 16 * 1024;
const ROOT_FIELDS = [
  "counts",
  "finishedAt",
  "lastSuccessfulAt",
  "producer",
  "schemaVersion",
  "startedAt",
  "status",
  "unread",
];
const COUNT_FIELDS = ["downloaded", "failures", "markdown", "skipped", "uncopied"];
const STATUSES = new Set(["running", "complete", "partial", "failed"]);
const UNREAD_CATEGORIES = new Set(["announcements", "conversations"]);
const RETRY_OR_REPORT = "Run the same sync again; if it repeats, report an ntulearn defect.";

export async function withImportStatus({
  destination,
  attempt,
  clock = () => new Date(),
  read = readFile,
  write = writeAtomically,
  createDestination = mkdir,
}) {
  await createDestination(destination, { recursive: true });
  const path = join(destination, IMPORT_STATUS_FILENAME);
  const startedAt = canonicalNow(clock);
  const lastSuccessfulAt = await retainedSuccess(path, startedAt, read);
  const running = receipt({ status: "running", startedAt, lastSuccessfulAt });

  await publish(path, running, write);

  try {
    const result = await attempt();
    const finishedAt = canonicalNow(clock);
    const unread = normalizedUnread(result.unread);
    const counts = countsFrom(result);
    const status = counts.failures === 0 && unread.length === 0 ? "complete" : "partial";
    await publish(
      path,
      receipt({
        status,
        startedAt,
        finishedAt,
        lastSuccessfulAt: status === "complete" ? finishedAt : lastSuccessfulAt,
        counts,
        unread,
      }),
      write,
    );
    return result;
  } catch (error) {
    try {
      const failed = receipt({
        status: "failed",
        startedAt,
        finishedAt: canonicalNow(clock),
        lastSuccessfulAt,
      });
      await publish(path, failed, write);
    } catch {}
    throw error;
  }
}

export function isValidImportStatus(value, observedAt) {
  if (!isPlainObject(value) || !hasExactFields(value, ROOT_FIELDS)) return false;
  if (value.schemaVersion !== 1 || value.producer !== "ntulearn") return false;
  if (!STATUSES.has(value.status)) return false;
  if (!canonicalAtOrBefore(value.startedAt, observedAt)) return false;
  if (!nullableCanonicalAtOrBefore(value.finishedAt, observedAt)) return false;
  if (!nullableCanonicalAtOrBefore(value.lastSuccessfulAt, observedAt)) return false;
  if (!validCounts(value.counts) || !validUnread(value.unread)) return false;
  if (
    value.status !== "complete" &&
    value.lastSuccessfulAt !== null &&
    value.lastSuccessfulAt > value.startedAt
  ) {
    return false;
  }

  const zeroCounts = COUNT_FIELDS.every((field) => value.counts[field] === 0);
  if (value.status === "running") {
    return value.finishedAt === null && zeroCounts && value.unread.length === 0;
  }
  if (value.finishedAt === null || value.finishedAt < value.startedAt) return false;
  if (value.status === "complete") {
    return (
      value.lastSuccessfulAt === value.finishedAt &&
      value.counts.failures === 0 &&
      value.unread.length === 0
    );
  }
  if (value.status === "partial") {
    return value.counts.failures > 0 || value.unread.length > 0;
  }
  return true;
}

function receipt({
  status,
  startedAt,
  finishedAt = null,
  lastSuccessfulAt = null,
  counts = emptyCounts(),
  unread = [],
}) {
  return {
    schemaVersion: 1,
    producer: "ntulearn",
    status,
    startedAt,
    finishedAt,
    lastSuccessfulAt,
    counts,
    unread,
  };
}

function emptyCounts() {
  return { downloaded: 0, skipped: 0, markdown: 0, uncopied: 0, failures: 0 };
}

function countsFrom(result) {
  return {
    downloaded: result.downloaded,
    skipped: result.skipped,
    markdown: result.markdown,
    uncopied: result.uncopied,
    failures: result.failures.length,
  };
}

function normalizedUnread(unread = []) {
  return [...new Set(unread)].sort();
}

async function retainedSuccess(path, startedAt, read) {
  let source;
  try {
    source = await read(path, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES) return null;
  try {
    const prior = JSON.parse(source);
    return isValidImportStatus(prior, startedAt) ? prior.lastSuccessfulAt : null;
  } catch {
    return null;
  }
}

async function publish(path, value, write) {
  if (!isValidImportStatus(value, value.finishedAt ?? value.startedAt)) {
    throw new Error(`NTULearn produced an invalid import status receipt. ${RETRY_OR_REPORT}`);
  }
  const source = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES) {
    throw new Error(`Import status receipt exceeds 16 KiB. ${RETRY_OR_REPORT}`);
  }
  await write(path, source);
}

function canonicalNow(clock) {
  return clock().toISOString();
}

function validCounts(value) {
  return (
    isPlainObject(value) &&
    hasExactFields(value, COUNT_FIELDS) &&
    COUNT_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)
  );
}

function validUnread(value) {
  return (
    Array.isArray(value) &&
    value.every((category) => UNREAD_CATEGORIES.has(category)) &&
    value.every((category, index) => index === 0 || value[index - 1] < category)
  );
}

function canonicalAtOrBefore(value, observedAt) {
  return typeof value === "string" && canonicalTimestamp(value) && value <= observedAt;
}

function nullableCanonicalAtOrBefore(value, observedAt) {
  return value === null || canonicalAtOrBefore(value, observedAt);
}

function canonicalTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasExactFields(value, fields) {
  return Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
