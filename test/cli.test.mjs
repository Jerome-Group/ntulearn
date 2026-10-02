import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
    /^Usage: npm run login \| npm run discover \| npm run watchdog \| npm run \(sync\|verify\|renumber\) -- <course\|all> \| npm run media:setup \| npm run media:worker -- <scheduled\|manual> \| npm run media:discover -- <course\|all> \| npm run media:withdraw -- <course> <recordingId> confirm \| npm run media:evaluate -- <plan\|run> <manifest> \[fresh-output-directory\] \| npm run \(capabilities\|health\|status\|check\)\n$/,
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

test("evaluation plan validates private inputs without configuration or runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-cli-evaluation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  await writeFile(join(root, "audio.wav"), "fixture audio");
  const manifestPath = join(root, "private-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      budgets: {
        maxFixtureSeconds: 300,
        maxInputBytes: 1000,
        maxOutputBytes: 10000,
        jobTimeoutMs: 1000,
        processTimeoutMs: 500,
      },
      fixtures: [
        {
          audio: {
            path: "audio.wav",
            sha256: createHash("sha256").update("fixture audio").digest("hex"),
          },
          reference: { kind: "unavailable" },
        },
      ],
    }),
  );
  const result = await new Promise((done) => {
    execFile(
      process.execPath,
      [join(root, "src/cli.mjs"), "media-evaluate", "plan", manifestPath],
      { env: { ...process.env, NTULEARN_CONFIG_PATH: join(root, "absent-secret-config.json") } },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const planned = JSON.parse(result.stdout);
  assert.equal(planned.status, "passed");
  assert.equal(planned.evidence.execution, "unrun");
  assert.equal(planned.evidence.acousticQuality, "unrun");
  assert.doesNotMatch(result.stdout, /private-manifest|audio\.wav|absent-secret-config/);
});

test("evaluation usage and unreadable manifests report structured outcomes without private paths", async () => {
  for (const args of [
    [],
    ["run", "private-source.json"],
    ["plan", "private-source.json", "unexpected-output"],
  ]) {
    const result = await runCli("media-evaluate", ...args);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "blocked");
  }
  const invalid = await runCli("media-evaluate", "plan", "private-source.json");
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr, "");
  assert.equal(JSON.parse(invalid.stdout).status, "failed");
  assert.match(JSON.parse(invalid.stdout).checks[0].action, /retry plan/);
  assert.doesNotMatch(JSON.parse(invalid.stdout).checks[0].action, /output directory|retained/);
  assert.doesNotMatch(invalid.stdout, /private-source|node_modules|\n\s+at /);
});

test("evaluation provenance cleanup uncertainty stops before runtime or model work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-cli-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  const marker = join(root, "later-evaluation-work");
  await writeFile(
    join(root, "src/media/evaluation.mjs"),
    `import {writeFile} from 'node:fs/promises';
export async function runMediaEvaluation(){
  await writeFile(${JSON.stringify(marker)}, 'unexpected runtime/model boundary');
  return {status:'passed', exitCode:0, checks:[]};
}
`,
  );
  const configPath = join(root, "courses.json");
  await writeFile(configPath, JSON.stringify({ courses: [] }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    "#!/usr/bin/env node\nprocess.stderr.write('private provenance diagnostic'); setTimeout(()=>{},100);\n",
    { mode: 0o755 },
  );
  const fault = join(root, "group-fault.mjs");
  await writeFile(
    fault,
    `const kill=process.kill.bind(process); let probes=0;
process.kill=(pid,signal)=>{
  if(pid<0 && signal===0 && ++probes===Number(process.env.FIXTURE_FAILED_PROBE)){
    const error=new Error('private cleanup diagnostic'); error.code='EPERM'; throw error;
  }
  return kill(pid,signal);
};
`,
  );
  for (const failedProbe of [1, 2]) {
    const result = await new Promise((done) => {
      execFile(
        process.execPath,
        [
          "--import",
          fault,
          join(root, "src/cli.mjs"),
          "media-evaluate",
          "run",
          join(root, "private-manifest.json"),
          join(root, "fresh-output"),
        ],
        {
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            NTULEARN_CONFIG_PATH: configPath,
            FIXTURE_FAILED_PROBE: String(failedProbe),
          },
        },
        (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.checks[0].code, "MEDIA_PROCESS_CLEANUP");
    assert.match(report.checks[0].action, /stop.*inspect/i);
    assert.doesNotMatch(result.stdout, /private.*diagnostic|private-manifest|fresh-output|EPERM/);
    assert.equal(result.stdout.includes(root), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "fresh-output", "provenance.json")), {
      code: "ENOENT",
    });
  }
});
