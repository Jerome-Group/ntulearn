import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// `URL.pathname` percent-encodes, and a checkout can live under a path with a space in it.
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const STACK_FRAME = /\n\s+at /;

// execFile rejects on a non-zero exit, and the rejection carries the streams. Both outcomes are
// expected here, so the code is part of what is asserted rather than a reason to throw.
async function runCli(...args) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-cli-isolated-"));
  const example = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../config/courses.example.json", import.meta.url)),
      "utf8",
    ),
  );
  const configPath = join(root, "courses.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...example,
      statePath: join(root, "state.json"),
      profilePath: join(root, "profile"),
    }),
  );
  try {
    const result = await runCliWithEnvironment(
      { ...process.env, NTULEARN_CONFIG_PATH: configPath },
      ...args,
    );
    const sandboxDigest = await readFile(join(root, "media-latest.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return { ...result, sandboxDigest: sandboxDigest ? JSON.parse(sandboxDigest) : null };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCliWithEnvironment(env, ...args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) =>
      done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("prints usage and exits 1 when given no command", async () => {
  const { code, stdout, stderr } = await runCli();
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(
    stderr,
    /^Usage: npm run login \| npm run discover \| npm run watchdog \| npm run \(sync\|verify\|renumber\) -- <course\|all> \| npm run media:setup \| npm run media:worker -- <scheduled\|manual> \| npm run media:discover -- <course\|all> \| npm run media:withdraw -- <course> <recordingId> confirm \| npm run \(capabilities\|health\|status\|check\)\n$/,
  );
});

test("prints usage and exits 1 for a command that does not exist", async () => {
  const { code, stderr } = await runCli("frobnicate");
  assert.equal(code, 1);
  assert.match(stderr, /^Usage: /);
});

// The regression this holds: every failure used to surface as an unhandled rejection, which
// prints a stack trace and exits 1 by accident rather than on purpose. What the message says
// depends on whether this machine has a `config/courses.json` — that it is one line and not a
// stack trace does not.
test("reports a failure as one line and no stack trace", async () => {
  const { code, stdout, stderr } = await runCli("sync", "ZZ9999");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.doesNotMatch(stderr, STACK_FRAME);
  assert.equal(stderr.trimEnd().split("\n").length, 1);
  assert.match(stderr, /^(Unknown course: ZZ9999|No config\/courses\.json\.)/);
});

test("keeps media setup explicit and owner-started", async () => {
  const { code, stdout, stderr } = await runCli("media-setup");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.doesNotMatch(stderr, STACK_FRAME);
  assert.match(
    stderr,
    /^(Media setup is (?:not configured|missing selected runtimes and models)|No config\/courses\.json\.)/,
  );
});

test("keeps default media worker CLI evidence inside its disposable sandbox", async () => {
  const { code, stdout, stderr, sandboxDigest } = await runCli("media-worker", "manual");
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).verdict, "green");
  assert.deepEqual(sandboxDigest, JSON.parse(stdout));
  assert.equal(sandboxDigest.counts.total, 0);
});

test("rejects an unknown media worker mode", async () => {
  const { code, stdout, stderr } = await runCli("media-worker", "fast");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^Usage: npm run media:worker -- <scheduled\|manual>\n$/);
});

test("exits non-zero when the aggregate media verdict is red", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-cli-media-red-"));
  const configPath = join(root, "courses.json");
  await writeFile(configPath, JSON.stringify(redMediaConfig(root)));

  const { code, stdout, stderr } = await runCliWithEnvironment(
    { ...process.env, NTULEARN_CONFIG_PATH: configPath },
    "media-worker",
    "manual",
  );

  assert.equal(code, 1);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).verdict, "red");
});

function redMediaConfig(root) {
  const artifact = (name, filename) => ({
    name,
    filename,
    source: "/missing",
    revision: "r1",
    sha256: "a".repeat(64),
    license: "MIT",
  });
  return {
    statePath: join(root, "state.json"),
    media: {
      mediaRoot: `/Volumes/RAID0/.ntulearn-missing-${process.pid}-${Date.now()}`,
      setup: {
        mediaTool: artifact("FFmpeg", "ffmpeg"),
        asr: {
          runtime: artifact("whisper.cpp", "whisper-cli"),
          model: artifact("Whisper", "whisper.bin"),
        },
        formatter: {
          runtime: artifact("llama.cpp", "llama-cli"),
          model: artifact("Formatter", "formatter.gguf"),
        },
      },
    },
    courses: [
      {
        key: "AB1001",
        courseId: "_1_1",
        destination: join(root, "course"),
        mediaMode: "active",
      },
    ],
  };
}

test("offline commands work without configuration, dependencies or browser installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn fresh agent ü "));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  const env = { ...process.env, NTULEARN_CONFIG_PATH: "missing-private-config.json" };
  const run = (name) =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [join(root, "src/cli.mjs"), name],
        { cwd: root, env },
        (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
  const index = await run("capabilities");
  assert.equal(index.code, 0);
  assert.equal(index.stderr, "");
  assert.equal(JSON.parse(index.stdout).schemaVersion, 1);
  for (const name of ["health", "status"]) {
    const result = await run(name);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "blocked");
    assert.doesNotMatch(result.stdout, /missing-private-config/);
  }
});

test("offline usage failures preserve structured output and nonzero exits", async () => {
  for (const args of [
    ["capabilities", "unknown"],
    ["status", "unexpected"],
    ["check", "unknown"],
  ]) {
    const result = await runCli(...args);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "blocked");
  }
});
