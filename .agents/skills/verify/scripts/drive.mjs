#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPTS =
  "capabilities health status library check check:syntax check:contracts login discover watchdog sync verify renumber test lint format format:check"
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
  library: [
    [["library"], "library-ready", 0],
    [["library", "--course", "ab1234", "--query", "CONVERGENCE"], "library-ready", 0],
    [["library", "--query", "exam ü"], "library-ready", 0],
    [["library", "--query", "no matching phrase"], "library-ready", 0],
    [["library", "--html", "--query", "convergence"], "library-ready", 0],
    [["library"], "library-partial", 1],
    [["library"], "library-runtime", 2, "RUNTIME_OVERLAP"],
    [["library"], "missing-config", 2, "CONFIG_UNAVAILABLE"],
    [["library", "--unknown"], "missing-config", 2, "USAGE"],
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
  "Usage: drive.mjs <doctor|cli|local|library|session|copy|watchdog>",
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
  if (args[0] === "library") {
    observeLibrary(record, args, kind, code);
    return;
  }
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
    if (args[0] === "status" && kind !== "missing-config") {
      const receipts = value.checks.find((entry) => entry.id === "sync-receipts");
      const counter = {
        ready: "complete",
        "missing-receipt": "missing",
        "old-receipt": "stale",
        "old-digest": "complete",
        "failed-receipt": "failed",
        "red-digest": "complete",
        "invalid-receipt": "invalid",
      }[kind];
      assert.equal(receipts.evidence[counter], 1, `observed ${counter} receipt`);
      assert.equal(
        receipts.status,
        ["failed-receipt", "invalid-receipt"].includes(kind)
          ? "failed"
          : ["missing-receipt", "old-receipt"].includes(kind)
            ? "blocked"
            : "passed",
      );
      assert.equal(value.evidence.artifactBytes, "unrun");
    }
    if (kind === "ready") assert.equal(value.evidence.upstreamCompleteness, "unrun");
    if (args[0] === "health" && kind === "ready")
      assert.equal(value.checks.find((entry) => entry.id === "session-validity").status, "unrun");
    assert(!value.checks.some((entry) => /media|runtime/.test(entry.id)));
  }
}

function observeLibrary(record, args, kind, code) {
  assert.equal(record.stderr, "");
  if (args.includes("--html")) {
    assert(record.stdout.startsWith("<!doctype html>"));
    const payload = record.stdout.match(
      /<script id="catalogue" type="application\/json">([\s\S]*?)<\/script>/,
    );
    assert(payload, "HTML embeds a safe catalogue");
    const catalogue = JSON.parse(payload[1]);
    assert.equal(catalogue.materials.length, 3, "clearing the query retains all selected material");
    assert(catalogue.materials.some((entry) => entry.text.value?.includes("</script><img")));
    assert(!record.stdout.includes('</script><img src="https://example.invalid/injected">'));
    assert(record.stdout.includes("Content-Security-Policy"));
    assert(record.stdout.includes('id="reader-text"'));
    return;
  }
  const value = JSON.parse(record.stdout);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.command, "library");
  assert.equal(value.exitCode, record.exitCode);
  if (code) {
    assert(value.diagnostics.some((entry) => entry.code === code && entry.action));
    return;
  }
  assert.equal(value.evidence.upstreamCompleteness, "unverified");
  assert.equal(value.evidence.currentSourceRevision, "unverified");
  assert.equal(
    value.materialCount,
    kind === "library-partial" ? 4 : args.includes("--course") ? 2 : 3,
  );
  assert.equal(
    value.matchCount,
    args.includes("CONVERGENCE") || args.includes("exam ü")
      ? 1
      : args.includes("no matching phrase")
        ? 0
        : value.materialCount,
  );
  assert.equal(value.courses[0].receipt.state, "partial");
  assert.equal(value.courses[0].receipt.stale, true);
  assert.deepEqual(value.courses[0].receipt.value.unread, ["announcements"]);
  assert.equal(value.courses[0].exclusions.symlink, 1);
  assert.equal(value.courses[0].exclusions.provenance, 1);
  assert.equal(value.courses[0].exclusions.hidden, 1);
  assert.equal(value.courses[0].exclusions.temporary, 1);
  assert(!record.stdout.includes("ATTACHMENT_BYTES_NOT_SEARCHABLE"));
  assert(!record.stdout.includes("PROVENANCE_NOT_SEARCHABLE"));
  if (args.includes("CONVERGENCE")) assert(value.materials[0].snippet.includes("convergence"));
  if (kind === "library-partial") {
    assert.equal(value.status, "partial");
    assert(value.courses[0].diagnostics.some((entry) => entry.code === "TEXT_LIMIT"));
    assert(
      value.materials.some(
        (entry) => entry.name === "Oversized.md" && entry.text.state === "omitted",
      ),
    );
  }
}

async function fixture(root, kind) {
  const path = join(root, "courses.json");
  if (kind === "missing-config") return path;
  if (kind.startsWith("library-")) return libraryFixture(root, kind, path);
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

async function libraryFixture(root, kind, path) {
  const destination = join(root, "AB1234");
  const second = join(root, "CD5678");
  const runtime = join(root, "private-runtime");
  await mkdir(destination);
  await mkdir(second);
  await mkdir(runtime, { mode: 0o700 });
  await json(path, {
    profilePath:
      kind === "library-runtime"
        ? join(destination, "nonhidden-profile")
        : join(runtime, "profile"),
    statePath: join(runtime, "state.json"),
    courses: [
      { key: "AB1234", courseId: "_verification_fixture_1", destination },
      { key: "CD5678", courseId: "_verification_fixture_2", destination: second },
    ],
  });
  await writeFile(
    join(destination, "Page.md"),
    '# Saved page\nUniform convergence is in the document body.\n</script><img src="https://example.invalid/injected">\n',
  );
  await writeFile(join(destination, "Exam ü #1.pdf"), "ATTACHMENT_BYTES_NOT_SEARCHABLE");
  await writeFile(join(second, "Announcement.md"), "# Announcement\nThe lecture moved.");
  await mkdir(join(destination, "Source editions"));
  await writeFile(
    join(destination, "Source editions", "provenance.md"),
    "PROVENANCE_NOT_SEARCHABLE",
  );
  await mkdir(join(destination, ".hidden"));
  await writeFile(join(destination, ".hidden", "private.md"), "HIDDEN_NOT_SEARCHABLE");
  await writeFile(join(destination, "Pending.md.part-123"), "TEMPORARY_NOT_SEARCHABLE");
  await symlink(second, join(destination, "Nested alias"));
  const timestamp = new Date(Date.now() - 72 * 3600000).toISOString();
  await json(join(destination, "Sync status.json"), {
    schemaVersion: 1,
    producer: "ntulearn",
    status: "partial",
    startedAt: timestamp,
    finishedAt: timestamp,
    lastSuccessfulAt: null,
    counts: { downloaded: 0, skipped: 0, markdown: 1, uncopied: 0, failures: 1 },
    unread: ["announcements"],
  });
  if (kind === "library-partial")
    await writeFile(join(destination, "Oversized.md"), "x".repeat(256 * 1024 + 1));
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
      !/VERIFY_PRIVATE_FIXTURE|_verification_fixture_[12]/.test(record.stdout),
      "stdout excludes upstream identifiers",
    );
    if (args[0] !== "library")
      assert(!record.stdout.includes(root), "operational output excludes private paths");
    record.assertions.push(
      args[0] === "library"
        ? "private local output excludes upstream identifiers"
        : "stdout excludes private fixture identifiers and paths",
    );
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
