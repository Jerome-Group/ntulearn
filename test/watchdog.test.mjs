import assert from "node:assert/strict";
import test from "node:test";
import { watchdogVerdict } from "../src/watchdog/verdict.mjs";

test("reports a green run with the files it added", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: { exitCode: 0, report: { courses: [{ downloaded: 2, markdownWritten: 3 }] } },
      verify: { exitCode: 0, report: { complete: true } },
      preChecks: {},
      attempts: 1,
    }),
    { verdict: "green", message: "synced, 5 new files" },
  );
});

test("reports the first sync failure with its trail", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: {
        exitCode: 1,
        report: {
          courses: [
            {
              failures: [
                { file: "Guide.pdf", trail: "Week 1", path: "01 Week 1/01 Guide.pdf" },
                { file: "Answers.pdf", trail: "Week 2", path: "02 Week 2/01 Answers.pdf" },
              ],
            },
          ],
        },
      },
      verify: { exitCode: 0, report: { complete: true } },
      preChecks: {},
      attempts: 1,
    }),
    {
      verdict: "red",
      message:
        "sync failed: 2 failures; first failure: Guide.pdf (trail: Week 1); run npm run watchdog",
    },
  );
});

test("reports the first missing path from verify", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: { exitCode: 0, report: { courses: [] } },
      verify: {
        exitCode: 1,
        report: {
          complete: false,
          courses: [
            {
              missing: [
                { file: "Week 2.pdf", trail: "Week 1", path: "01 Week 1/02 Week 2.pdf" },
                { file: "Course.md", trail: "", path: "Course.md" },
              ],
            },
          ],
        },
      },
      preChecks: {},
      attempts: 1,
    }),
    {
      verdict: "red",
      message:
        "verify failed: 2 missing files; first path: 01 Week 1/02 Week 2.pdf; run npm run watchdog",
    },
  );
});

test("reports a lapsed session without retrying its remedy", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: { exitCode: 1, stderr: "The saved session is no longer signed in. Run: npm run login" },
      verify: {
        exitCode: 1,
        stderr: "The saved session is no longer signed in. Run: npm run login",
      },
      preChecks: {},
      attempts: 1,
    }),
    { verdict: "red", message: "session lapsed — run `npm run login`" },
  );
});

test("reports a 401 caught during a file download as a lapsed session", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: {
        exitCode: 1,
        report: {
          courses: [
            {
              failures: [
                { file: "Guide.pdf", trail: "Week 1", error: "Download failed: HTTP 401" },
              ],
            },
          ],
        },
      },
      verify: { exitCode: 0, report: { complete: true } },
      preChecks: {},
      attempts: 1,
    }),
    { verdict: "red", message: "session lapsed — run `npm run login`" },
  );
});

test("does not call a sign-in stall a lapsed session just because it names the remedy", () => {
  const result = watchdogVerdict({
    sync: {
      exitCode: 1,
      stderr:
        "NTULearn did not answer within 60s. Run the command again, and if it keeps happening: Run: npm run login",
    },
    verify: { exitCode: 1, stderr: "same stall" },
    preChecks: {},
    attempts: 1,
  });

  assert.equal(result.verdict, "red");
  assert.doesNotMatch(result.message, /session lapsed/);
});

test("reports a lock collision as a skipped yellow run", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: null,
      verify: null,
      preChecks: { lockHeld: true },
      attempts: 0,
    }),
    { verdict: "yellow", message: "skipped: a run was already going" },
  );
});

test("reports both red command results without adding drift or refusal noise", () => {
  const result = watchdogVerdict({
    sync: {
      exitCode: 1,
      report: {
        courses: [
          {
            failures: [{ file: "Guide.pdf", trail: "Week 1", path: "01 Week 1/01 Guide.pdf" }],
            renumbered: [{ file: "Old.pdf" }],
          },
        ],
        refused: [{ key: "CLOSED", reason: "closed course" }],
      },
    },
    verify: {
      exitCode: 1,
      report: {
        complete: false,
        courses: [
          {
            missing: [{ file: "Course.md", trail: "", path: "Course.md" }],
            renumbered: [{ file: "Other.pdf" }],
          },
        ],
        refused: [{ key: "CLOSED", reason: "closed course" }],
        notCovered: ["not covered detail"],
      },
    },
    preChecks: {},
    attempts: 1,
  });

  assert.deepEqual(result, {
    verdict: "red",
    message:
      "sync failed: 1 failures; first failure: Guide.pdf (trail: Week 1); run npm run watchdog; verify failed: 1 missing files; first path: Course.md; run npm run watchdog",
  });
  assert.doesNotMatch(result.message, /CLOSED|renumbered|not covered/i);
});

test("keeps refused courses and verify drift out of a green digest", () => {
  const result = watchdogVerdict({
    sync: {
      exitCode: 0,
      report: {
        courses: [{ downloaded: 0, markdownWritten: 0, renumbered: 1 }],
        refused: [{ key: "CLOSED", reason: "closed course" }],
      },
    },
    verify: {
      exitCode: 0,
      report: {
        complete: true,
        courses: [{ renumbered: [{ file: "Old.pdf" }] }],
        refused: [{ key: "CLOSED", reason: "closed course" }],
        notCovered: ["not covered detail"],
      },
    },
    preChecks: {},
    attempts: 1,
  });

  assert.deepEqual(result, { verdict: "green", message: "synced, 0 new files" });
  assert.doesNotMatch(result.message, /CLOSED|renumbered|not covered/i);
});

test("refuses a run when the Drive mount is absent", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: null,
      verify: null,
      preChecks: { driveMount: { path: "/Volumes/Google Drive", present: false } },
      attempts: 0,
    }),
    {
      verdict: "red",
      message:
        "Drive not mounted — no run attempted; mount Google Drive, then run: npm run watchdog",
    },
  );
});

test("reports an exhausted crash or timeout with its attempts and stderr tail", () => {
  assert.deepEqual(
    watchdogVerdict({
      sync: {
        exitCode: 1,
        timedOut: true,
        stderr: "",
        report: null,
      },
      verify: null,
      preChecks: { driveMount: { path: "/Volumes/Google Drive", present: true } },
      attempts: 3,
      attemptResults: [{ sync: { stderr: "Chrome stopped responding" }, verify: null }],
    }),
    {
      verdict: "red",
      message:
        "crash/timeout after 3 attempts; stderr tail: Chrome stopped responding; inspect the run log for the captured attempts",
    },
  );
});
