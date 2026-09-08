import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncCourse } from "../src/sync/course.mjs";
import {
  IMPORT_STATUS_FILENAME,
  isValidImportStatus,
  withImportStatus,
} from "../src/sync/import-status.mjs";

const FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/import-status-v1.json", import.meta.url), "utf8"),
);
const RESULT = {
  downloaded: 2,
  skipped: 3,
  markdown: 4,
  uncopied: 0,
  failures: [],
};

test("publishes the shared v1 receipt shape", async () => {
  const writes = [];
  await withImportStatus({
    destination: "/course",
    attempt: async () => RESULT,
    clock: sequence("2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z"),
    read: missing,
    write: capture(writes),
    createDestination: noOp,
  });

  assert.equal(writes[0].path, join("/course", IMPORT_STATUS_FILENAME));
  assert.deepEqual(writes[1].value, FIXTURE);
  assert.equal(isValidImportStatus(writes[1].value, FIXTURE.finishedAt), true);
});

test("publishes an unchanged walk as complete with its existing document tally", async () => {
  const writes = [];
  await withImportStatus({
    destination: "/course",
    attempt: async () => ({ ...RESULT, downloaded: 0, skipped: 5 }),
    clock: sequence("2026-09-08T00:02:00.000Z", "2026-09-08T00:03:00.000Z"),
    read: async () => JSON.stringify(FIXTURE),
    write: capture(writes),
    createDestination: noOp,
  });

  assert.equal(writes[0].value.status, "running");
  assert.equal(writes[0].value.lastSuccessfulAt, FIXTURE.lastSuccessfulAt);
  const receipt = writes.at(-1).value;
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.lastSuccessfulAt, receipt.finishedAt);
  assert.deepEqual(receipt.counts, {
    downloaded: 0,
    skipped: 5,
    markdown: 4,
    uncopied: 0,
    failures: 0,
  });
});

test("makes running observable before the course read finishes", async () => {
  const writes = [];
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const attempted = new Promise((resolve) => {
    entered = resolve;
  });
  const running = withImportStatus({
    destination: "/course",
    attempt: async () => {
      entered();
      await blocked;
      return RESULT;
    },
    clock: sequence("2026-09-08T00:02:00.000Z", "2026-09-08T00:03:00.000Z"),
    read: missing,
    write: capture(writes),
    createDestination: noOp,
  });

  await attempted;
  assert.deepEqual(
    writes.map(({ value }) => value.status),
    ["running"],
  );
  assert.deepEqual(writes[0].value.counts, {
    downloaded: 0,
    skipped: 0,
    markdown: 0,
    uncopied: 0,
    failures: 0,
  });
  assert.equal(writes[0].value.finishedAt, null);
  release();
  await running;
});

test("syncCourse publishes running before its blocked NTULearn read", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-import-status-"));
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const attempted = new Promise((resolve) => {
    entered = resolve;
  });
  const syncing = syncCourse({
    client: {
      async readCourse() {
        entered();
        await blocked;
        return {
          course: { displayName: "Synthetic course" },
          announcements: [],
          conversations: [],
          items: [],
        };
      },
    },
    course: { key: "AB1001", courseId: "synthetic", destination },
    state: { version: 1, courses: {} },
  });

  await attempted;
  const running = JSON.parse(await readFile(join(destination, IMPORT_STATUS_FILENAME), "utf8"));
  assert.equal(running.status, "running");
  release();
  await syncing;
});

test("publishes partial for transfers or optional categories it could not read", async () => {
  const writes = [];
  await withImportStatus({
    destination: "/course",
    attempt: async () => ({
      ...RESULT,
      failures: [{ error: "private raw error", path: "private/source/path" }],
      unread: ["conversations", "announcements", "conversations"],
    }),
    clock: sequence("2026-09-08T00:02:00.000Z", "2026-09-08T00:03:00.000Z"),
    read: async () => JSON.stringify(FIXTURE),
    write: capture(writes),
    createDestination: noOp,
  });

  const receipt = writes.at(-1).value;
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.lastSuccessfulAt, FIXTURE.lastSuccessfulAt);
  assert.equal(receipt.counts.failures, 1);
  assert.deepEqual(receipt.unread, ["announcements", "conversations"]);
  assert.doesNotMatch(JSON.stringify(receipt), /private raw error|private\/source\/path/);
});

test("publishes failed and rethrows the original course error", async () => {
  const writes = [];
  const courseError = new Error("course URL and raw failure stay outside the receipt");
  await assert.rejects(
    withImportStatus({
      destination: "/course",
      attempt: async () => {
        throw courseError;
      },
      clock: sequence("2026-09-08T00:02:00.000Z", "2026-09-08T00:03:00.000Z"),
      read: async () => JSON.stringify(FIXTURE),
      write: capture(writes),
      createDestination: noOp,
    }),
    (error) => error === courseError,
  );

  assert.equal(writes.at(-1).value.status, "failed");
  assert.equal(writes.at(-1).value.lastSuccessfulAt, FIXTURE.lastSuccessfulAt);
  assert.doesNotMatch(JSON.stringify(writes.at(-1).value), /course URL|raw failure/);
});

test("keeps the original course error when publishing failed also fails", async () => {
  const courseError = new Error("course failed");
  let publications = 0;
  await assert.rejects(
    withImportStatus({
      destination: "/course",
      attempt: async () => {
        throw courseError;
      },
      clock: sequence("2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z"),
      read: missing,
      write: async () => {
        publications += 1;
        if (publications === 2) throw new Error("failed receipt write failed");
      },
      createDestination: noOp,
    }),
    (error) => error === courseError,
  );
});

test("turns a terminal publication failure into failed and propagates the write error", async () => {
  const writes = [];
  const terminalError = new Error("terminal write failed");
  let publications = 0;
  await assert.rejects(
    withImportStatus({
      destination: "/course",
      attempt: async () => RESULT,
      clock: sequence(
        "2026-09-08T00:00:00.000Z",
        "2026-09-08T00:01:00.000Z",
        "2026-09-08T00:01:01.000Z",
      ),
      read: missing,
      write: async (path, source) => {
        publications += 1;
        if (publications === 2) throw terminalError;
        writes.push({ path, value: JSON.parse(source) });
      },
      createDestination: noOp,
    }),
    (error) => error === terminalError,
  );
  assert.deepEqual(
    writes.map(({ value }) => value.status),
    ["running", "failed"],
  );
});

test("refuses to publish a terminal receipt produced by an invalid clock or tally", async () => {
  const writes = [];
  await assert.rejects(
    withImportStatus({
      destination: "/course",
      attempt: async () => ({ ...RESULT, downloaded: -1 }),
      clock: sequence(
        "2026-09-08T00:02:00.000Z",
        "2026-09-08T00:01:00.000Z",
        "2026-09-08T00:03:00.000Z",
      ),
      read: missing,
      write: capture(writes),
      createDestination: noOp,
    }),
    {
      message:
        "NTULearn produced an invalid import status receipt. Run the same sync again; if it repeats, report an ntulearn defect.",
    },
  );
  assert.deepEqual(
    writes.map(({ value }) => value.status),
    ["running", "failed"],
  );
});

test("drops unreadable prior success and continues from a fresh running receipt", async () => {
  const writes = [];
  let attempted = false;
  await withImportStatus({
    destination: "/course",
    attempt: async () => {
      attempted = true;
      return { ...RESULT, failures: [{}] };
    },
    clock: sequence("2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z"),
    read: async () => {
      throw Object.assign(new Error("private historical read error"), { code: "EACCES" });
    },
    write: capture(writes),
    createDestination: noOp,
  });
  assert.equal(attempted, true);
  assert.deepEqual(
    writes.map(({ value }) => [value.status, value.lastSuccessfulAt]),
    [
      ["running", null],
      ["partial", null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(writes), /private historical read error/);
});

test("does not begin a course read when running cannot be published", async () => {
  let attempted = false;
  const writeError = new Error("running write failed");
  await assert.rejects(
    withImportStatus({
      destination: "/course",
      attempt: async () => {
        attempted = true;
        return RESULT;
      },
      clock: sequence("2026-09-08T00:00:00.000Z"),
      read: missing,
      write: async () => {
        throw writeError;
      },
      createDestination: noOp,
    }),
    (error) => error === writeError,
  );
  assert.equal(attempted, false);
});

test("drops malformed, unsupported, oversized, and future prior successes", async () => {
  const priors = [
    "not json",
    JSON.stringify({ ...FIXTURE, schemaVersion: 2 }),
    `${" ".repeat(16 * 1024)}\n`,
    JSON.stringify({
      ...FIXTURE,
      startedAt: "2026-09-08T00:02:00.000Z",
      finishedAt: "2026-09-08T00:03:00.000Z",
      lastSuccessfulAt: "2026-09-08T00:03:00.000Z",
    }),
  ];

  for (const prior of priors) {
    const writes = [];
    await withImportStatus({
      destination: "/course",
      attempt: async () => ({ ...RESULT, failures: [{}] }),
      clock: sequence("2026-09-08T00:01:00.000Z", "2026-09-08T00:01:30.000Z"),
      read: async () => prior,
      write: capture(writes),
      createDestination: noOp,
    });
    assert.equal(writes[0].value.lastSuccessfulAt, null);
    assert.equal(writes[1].value.lastSuccessfulAt, null);
  }
});

function sequence(...timestamps) {
  let index = 0;
  return () => new Date(timestamps[index++]);
}

async function missing() {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

async function noOp() {}

function capture(writes) {
  return async (path, source) => writes.push({ path, value: JSON.parse(source) });
}
