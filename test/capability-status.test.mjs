import assert from "node:assert/strict";
import test from "node:test";
import { localStatus } from "../src/capabilities/status.mjs";

const now = () => new Date("2026-10-02T00:00:00.000Z");
const receipt = () => ({
  schemaVersion: 1,
  producer: "ntulearn",
  status: "complete",
  startedAt: "2026-10-01T00:00:00.000Z",
  finishedAt: "2026-10-01T00:01:00.000Z",
  lastSuccessfulAt: "2026-10-01T00:01:00.000Z",
  counts: { downloaded: 0, skipped: 1, markdown: 0, uncopied: 0, failures: 0 },
  unread: [],
});
const config = {
  statePath: "/private/fixture/state.json",
  courses: [{ key: "PRIVATE", courseId: "_private_1", destination: "/private/course" }],
};

test("status separates missing, incomplete, complete receipts and stale evidence", async () => {
  let observedReceipt = receipt();
  const read = async (path) => ({
    status: "passed",
    value: path.endsWith("Sync status.json")
      ? observedReceipt
      : {
          verdict: "green",
          timestamp: "2026-10-01T00:01:00.000Z",
          message: "PRIVATE course",
          runLog: "/private/log",
        },
  });
  const options = { root: "/private/root", now, load: async () => config, read };
  const ready = await localStatus(options);
  assert.equal(ready.status, "passed");
  assert.equal(ready.evidence.upstreamCompleteness, "unrun");
  assert.ok(!JSON.stringify(ready).includes("PRIVATE"));
  assert.ok(!JSON.stringify(ready).includes("/private/"));
  observedReceipt = {
    ...receipt(),
    status: "running",
    finishedAt: null,
    lastSuccessfulAt: null,
    counts: { downloaded: 0, skipped: 0, markdown: 0, uncopied: 0, failures: 0 },
  };
  assert.equal((await localStatus(options)).status, "blocked");
  observedReceipt = {
    ...receipt(),
    status: "partial",
    lastSuccessfulAt: null,
    counts: { ...receipt().counts, failures: 1 },
  };
  assert.equal((await localStatus(options)).status, "failed");
  observedReceipt = {
    ...receipt(),
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:01:00.000Z",
    lastSuccessfulAt: "2026-09-01T00:01:00.000Z",
  };
  assert.equal((await localStatus(options)).status, "blocked");
  assert.equal(
    (
      await localStatus({
        ...options,
        read: async () => ({ status: "blocked", code: "EVIDENCE_MISSING" }),
      })
    ).status,
    "blocked",
  );
});

test("status rejects future receipts", async () => {
  const result = await localStatus({
    root: "/fixture",
    now,
    load: async () => config,
    read: async (path) => ({
      status: "passed",
      value: path.endsWith("Sync status.json")
        ? { ...receipt(), startedAt: "2027-01-01T00:00:00.000Z" }
        : { verdict: "green", timestamp: "2026-10-01T00:00:00.000Z" },
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((check) => check.id === "sync-receipts").evidence.invalid, 1);
});
