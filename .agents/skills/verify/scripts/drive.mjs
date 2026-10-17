#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPTS =
  "capabilities health status check check:syntax check:contracts login discover watchdog sync verify renumber test lint format format:check"
    .split(" ")
    .sort();
const CASES = {
  doctor: [
    [["capabilities"], "missing-config", 0],
    [["check", "contracts"], "missing-config", 0],
  ],
  cli: [
    [["capabilities", "health"], "missing-config", 0],
    [["capabilities", "authentication"], "missing-config", 0],
    [["capabilities", "check:contracts"], "missing-config", 0],
    [["capabilities", "unknown-feature"], "missing-config", 2, "UNKNOWN_CAPABILITY"],
    [["capabilities", "media-worker"], "missing-config", 2, "UNKNOWN_CAPABILITY"],
    [["health", "unexpected"], "missing-config", 2, "USAGE"],
    [["check", "unknown"], "missing-config", 2, "CHECK_USAGE"],
    [["media-worker"], "missing-config", 1],
  ],
  local: [
    [["health"], "ready", 0, "SESSION_NOT_OPENED"],
    [["health"], "missing-config", 2, "CONFIG_UNAVAILABLE"],
    [["status"], "missing-config", 2, "CONFIG_UNAVAILABLE"],
    [["health"], "unsafe-profile", 1, "PROFILE_UNAVAILABLE_OR_UNSAFE"],
    [["status"], "ready", 0, "SYNC_RECEIPTS_COMPLETE"],
    [["status"], "missing-receipt", 2, "SYNC_RECEIPTS_INCOMPLETE"],
    [["status"], "old-receipt", 2, "SYNC_RECEIPTS_INCOMPLETE"],
    [["status"], "old-digest", 2, "DIGEST_STALE"],
    [["status"], "failed-receipt", 1, "SYNC_RECEIPTS_INCOMPLETE"],
    [["status"], "red-digest", 1, "DIGEST_RED"],
    [["status"], "invalid-receipt", 1, "SYNC_RECEIPTS_INCOMPLETE"],
  ],
  session: [
    [["login"], "missing-config", 1],
    [["discover"], "missing-config", 1],
  ],
  copy: ["sync", "verify", "renumber"].map((command) => [[command, "all"], "missing-config", 1]),
  watchdog: [[["watchdog"], "missing-config", 1]],
};
const PREREQUISITES = {
  session:
    "Owner invocation, private configuration, Chrome, NTU access, SSO/MFA, private 0700 profile.",
  copy: "Owner invocation, private configuration, authenticated Chrome, mounted Drive, distinct destinations; separate rename decision for renumber.",
  watchdog:
    "Owner invocation, private configuration, authenticated Chrome, mounted Drive, accessible destinations, available watchdog lock and retry time.",
};
const journey = process.argv[2];
assert(
  CASES[journey] && process.argv.length === 3,
  "Usage: drive.mjs <doctor|cli|local|session|copy|watchdog>",
);
await mkdir(join(ROOT, ".scratch"), { recursive: true });
const evidence = await mkdtemp(join(ROOT, ".scratch", "verify-"));
await chmod(evidence, 0o700);
const run = {
  journey,
  node: process.versions.node,
  startedAt: new Date().toISOString(),
  records: [],
};
let interrupted = false;
try {
  await doctor();
  if (journey !== "doctor") for (const entry of CASES[journey]) await drive(entry);
  if (PREREQUISITES[journey])
    run.fullJourney = {
      status: "verified-unreachable",
      attempted: CASES[journey].map(([args]) => args),
      prerequisites: PREREQUISITES[journey],
      proof: "Missing-config boundary only; full upstream/mutation journey unrun.",
    };
  run.outcome = "passed";
} catch (error) {
  run.outcome = "failed";
  run.error = error.message;
  if (journey !== "doctor" && !interrupted && !run.unsettled) {
    try {
      await doctor();
    } catch (failure) {
      run.doctorAfterSurprise = failure.message;
    }
  }
}
run.finishedAt = new Date().toISOString();
await json(join(evidence, "run.json"), run);
console.log(
  JSON.stringify(
    {
      outcome: run.outcome,
      evidence,
      ...(run.fullJourney ? { fullJourney: run.fullJourney } : {}),
    },
    null,
    2,
  ),
);
process.exitCode = run.outcome === "passed" ? 0 : 1;

async function doctor() {
  for (const entry of CASES.doctor) await drive(entry);
}

async function observe(record, [args, kind, exit, code]) {
  assert.equal(record.exitCode, exit);
  if (!record.stdout) {
    assert(
      args[0] === "media-worker"
        ? record.stderr.startsWith("Usage:") && !record.stderr.includes("media")
        : record.stderr.includes("Copy config/courses.example.json"),
      "expected refusal action",
    );
    return;
  }
  const value = JSON.parse(record.stdout);
  assert.equal(value.schemaVersion, 1);
  if (value.commands) {
    if (args[1])
      assert.deepEqual(
        value.commands.map((entry) => entry.id),
        [args[1] === "authentication" ? "login" : args[1]],
      );
    else {
      const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
      assert.deepEqual(Object.keys(manifest.scripts).sort(), SCRIPTS);
      assert.deepEqual(value.commands.map((entry) => entry.script).sort(), SCRIPTS);
      assert(!value.features.some((entry) => /media|transcript/.test(entry.id)));
      assert.equal(value.configuration.overrideEnvironmentVariable, "NTULEARN_CONFIG_PATH");
    }
  } else {
    assert.equal(value.command, args[0]);
    assert.equal(value.exitCode, exit);
    assert.equal(value.status, ["passed", "failed", "blocked"][exit]);
    if (code)
      assert(
        value.checks.some((entry) => entry.code === code),
        code,
      );
    if (args[0] === "check" && exit === 0)
      assert(
        value.evidence.selection === "contracts" &&
          value.checks.filter((entry) => entry.status === "passed").length >= 4,
        "actual repository contracts passed",
      );
    if (kind === "old-receipt")
      assert.equal(value.checks.find((entry) => entry.id === "sync-receipts").evidence.stale, 1);
    if (kind === "ready") assert.equal(value.evidence.upstreamCompleteness, "unrun");
    if (args[0] === "health" && kind === "ready")
      assert.equal(value.checks.find((entry) => entry.id === "session-validity").status, "unrun");
    assert(!value.checks.some((entry) => /media|runtime/.test(entry.id)));
  }
}

async function fixture(root, kind) {
  const path = join(root, "courses.json");
  if (kind === "missing-config") return path;
  const profile = join(root, "profile"),
    destination = join(root, "Drive", "course"),
    state = join(root, "state");
  await mkdir(profile, { mode: 0o700 });
  await chmod(profile, kind === "unsafe-profile" ? 0o755 : 0o700);
  await mkdir(destination, { recursive: true });
  await mkdir(state);
  await json(path, {
    profilePath: profile,
    statePath: join(state, "state.json"),
    driveMountPath: join(root, "Drive"),
    courses: [{ key: "VERIFY_PRIVATE_FIXTURE", courseId: "_verification_fixture_1", destination }],
  });
  await writeFile(join(destination, "owner-note.txt"), "Synthetic fixture.\n");
  const timestamp = new Date(
    Date.now() - (kind === "old-receipt" ? 72 * 3600000 : 1000),
  ).toISOString();
  if (kind !== "missing-receipt")
    await json(join(destination, "Sync status.json"), {
      schemaVersion: 1,
      producer: "ntulearn",
      status: kind === "failed-receipt" ? "failed" : "complete",
      startedAt: timestamp,
      finishedAt: timestamp,
      lastSuccessfulAt: kind === "failed-receipt" ? null : timestamp,
      counts: { downloaded: 0, skipped: 1, markdown: 0, uncopied: 0, failures: 0 },
      unread: [],
      ...(kind === "invalid-receipt" ? { unexpected: true } : {}),
    });
  await json(join(state, "latest.json"), {
    verdict: kind === "red-digest" ? "red" : "green",
    timestamp: new Date(Date.now() - (kind === "old-digest" ? 72 * 3600000 : 1000)).toISOString(),
  });
  return path;
}

async function drive(entry) {
  assert(!interrupted && !run.unsettled, "previous child must settle before another drive");
  const [args, kind] = entry;
  const root = await mkdtemp(join(tmpdir(), "ntulearn-verify-"));
  const path = join(
    evidence,
    `${String(run.records.length + 1).padStart(2, "0")}-${args.join("-")}-${kind}.json`,
  );
  const record = {
    command: [process.execPath, join(ROOT, "src", "cli.mjs"), ...args],
    assertions: [],
  };
  try {
    const configPath = await fixture(root, kind);
    record.environment = { NTULEARN_CONFIG_PATH: configPath };
    record.before = await snapshot(root);
    Object.assign(record, await execute(args, configPath));
    run.unsettled = !record.settled;
    assert(
      record.settled && !record.killed && !record.signal && !interrupted,
      "child settled without timeout or signal",
    );
    record.assertions.push("child settled without timeout or signal");
    assert(
      !record.stdout.includes(root) &&
        !/VERIFY_PRIVATE_FIXTURE|_verification_fixture_1/.test(record.stdout),
      "stdout excludes private fixture identifiers and paths",
    );
    record.assertions.push("stdout excludes private fixture identifiers and paths");
    await observe(record, entry);
    record.assertions.push("expected command response, schema, exit and observations");
  } catch (error) {
    record.error = error.message;
  } finally {
    try {
      if (!run.unsettled) {
        record.after = await snapshot(root);
        assert.deepEqual(record.after, record.before, "fixture modes and hashes unchanged");
        record.assertions.push("fixture modes and hashes unchanged");
      }
    } finally {
      if (!run.unsettled) await rm(root, { recursive: true, force: true });
      record.cleanup = {
        fixture: root,
        removed: await lstat(root).then(
          () => false,
          (error) => error.code === "ENOENT",
        ),
      };
      if (!record.cleanup.removed) record.error = "owned fixture removal unconfirmed";
      await json(path, record);
      assert((await lstat(path)).size > 0, "evidence survives cleanup");
      run.records.push(path);
    }
  }
  assert(!record.error, `${args.join(" ")} ${kind}: ${record.error}`);
}

function execute(args, configPath) {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [join(ROOT, "src", "cli.mjs"), ...args],
      {
        cwd: ROOT,
        env: { ...process.env, NTULEARN_CONFIG_PATH: configPath },
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        done({
          stdout,
          stderr,
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          signal: error?.signal ?? null,
          killed: error?.killed ?? false,
          settled: !child.pid || child.exitCode !== null || child.signalCode !== null,
          pid: child.pid,
          timeoutMs: 15000,
        });
      },
    );
    const stop = () => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("close", () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  });
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        relative = join(prefix, name),
        info = await lstat(path);
      entries.push({
        path: relative,
        mode: (info.mode & 0o777).toString(8),
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        ...(info.isFile()
          ? {
              sha256: createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
            }
          : {}),
      });
      if (info.isDirectory()) await visit(path, relative);
    }
  }
  await visit(root);
  return entries;
}

async function json(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
