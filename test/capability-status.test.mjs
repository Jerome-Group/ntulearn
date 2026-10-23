import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

for (const fifo of ["receipt", "digest"]) {
  test(`status rejects a FIFO ${fifo} without waiting for a writer`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-status-fifo-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const destination = join(root, "course");
    const configPath = join(root, "courses.json");
    await mkdir(destination);
    await writeFile(
      configPath,
      JSON.stringify({
        statePath: join(root, "state.json"),
        courses: [{ key: "PRIVATE", courseId: "_private_1", destination }],
      }),
    );
    const receiptPath = join(destination, "Sync status.json");
    const digestPath = join(root, "latest.json");
    const timestamp = new Date().toISOString();
    await writeFile(
      receiptPath,
      JSON.stringify({
        ...receipt(),
        startedAt: timestamp,
        finishedAt: timestamp,
        lastSuccessfulAt: timestamp,
      }),
    );
    await writeFile(digestPath, JSON.stringify({ verdict: "green", timestamp }));
    const evidencePath = fifo === "receipt" ? receiptPath : digestPath;
    await rm(evidencePath);
    execFileSync("mkfifo", [evidencePath]);

    const result = await new Promise((done) => {
      execFile(
        process.execPath,
        [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "status"],
        {
          env: { ...process.env, NTULEARN_CONFIG_PATH: configPath },
          timeout: 5000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
        },
        (error, stdout, stderr) =>
          done({ code: error?.code ?? 0, killed: error?.killed ?? false, stdout, stderr }),
      );
    });
    assert.equal(result.killed, false, "status must settle before the child timeout");
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.status, "failed");
    if (fifo === "receipt")
      assert.equal(
        observed.checks.find((check) => check.id === "sync-receipts").evidence.invalid,
        1,
      );
    else
      assert.equal(
        observed.checks.find((check) => check.id === "watchdog-digest").status,
        "failed",
      );
    assert.ok(!result.stdout.includes(root));
    assert.ok(!result.stdout.includes("PRIVATE"));
  });
}
