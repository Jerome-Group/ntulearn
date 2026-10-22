import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runWatchdog } from "../src/watchdog/run.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const PRIOR = {
  verdict: "green",
  message: "old successful run",
  timestamp: "2026-10-20T00:00:00.000Z",
  runLog: "logs/prior.json",
};
const CURRENT = {
  verdict: "green",
  message: "synced, 2 new files",
  timestamp: "2026-10-22T00:00:00.000Z",
  runLog: "logs/current.json",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-watchdog-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const driveMountPath = join(root, "Drive");
  await mkdir(join(state, "logs"), { recursive: true });
  await mkdir(driveMountPath);
  const priorLog = "retained earlier run evidence\n";
  const priorDigest = `${JSON.stringify(PRIOR)}\n`;
  await writeFile(join(state, PRIOR.runLog), priorLog);
  await writeFile(join(state, "latest.json"), priorDigest);
  const config = { statePath: join(state, "state.json"), driveMountPath, courses: [] };
  return {
    root,
    state,
    config,
    priorLog,
    priorDigest,
    run(source) {
      return runWatchdog({
        config,
        root,
        runner: {
          spawn: boundedSpawn,
          lock: () => ({
            command: process.execPath,
            argumentsFor: ["--input-type=module", "-e", source],
          }),
        },
      });
    },
  };
}

function boundedSpawn(command, args, options) {
  return spawn(command, args, { ...options, timeout: 5_000, killSignal: "SIGKILL" });
}

async function assertPriorRetained(f, latest = f.priorDigest) {
  assert.equal(await readFile(join(f.state, "latest.json"), "utf8"), latest);
  assert.equal(await readFile(join(f.state, PRIOR.runLog), "utf8"), f.priorLog);
  assert.deepEqual(await readdir(join(f.state, "logs")), ["prior.json"]);
}

function printDigest(digest, code = 0) {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(digest))}); process.exitCode = ${code};`;
}

test("never returns an earlier green digest when the current child exits 1 without a reply", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("process.exitCode = 1"), /exited 1.*[Ii]nspect/);
  await assertPriorRetained(f);
});

test("a missing current reply fails independently of absent or malformed latest.json", async (t) => {
  for (const latest of [null, "{broken earlier publication"]) {
    await t.test(latest === null ? "absent" : "malformed", async (t) => {
      const f = await fixture(t);
      if (latest === null) await rm(join(f.state, "latest.json"));
      else await writeFile(join(f.state, "latest.json"), latest);
      await assert.rejects(f.run("process.exitCode = 1"), /exited 1.*[Ii]nspect/);
      if (latest === null)
        await assert.rejects(readFile(join(f.state, "latest.json")), { code: "ENOENT" });
      else assert.equal(await readFile(join(f.state, "latest.json"), "utf8"), latest);
      assert.equal(await readFile(join(f.state, PRIOR.runLog), "utf8"), f.priorLog);
      assert.deepEqual(await readdir(join(f.state, "logs")), ["prior.json"]);
    });
  }
});

test("returns the current green or red reply when another invocation publishes latest.json", async (t) => {
  for (const [verdict, exitCode, message] of [
    ["green", 0, "synced, 2 new files"],
    ["red", 1, "verify failed; run npm run watchdog"],
  ]) {
    await t.test(verdict, async (t) => {
      const f = await fixture(t);
      const digest = { ...CURRENT, verdict, message };
      const unrelated = JSON.stringify({ ...PRIOR, message: "another invocation's digest" });
      const result = await f.run(`
        import { writeFile } from "node:fs/promises";
        await writeFile(${JSON.stringify(join(f.state, "latest.json"))}, ${JSON.stringify(unrelated)});
        ${printDigest(digest, exitCode)}
      `);
      assert.deepEqual(result, { digest, exitCode });
      await assertPriorRetained(f, unrelated);
    });
  }
});

test("missing acknowledgement preserves what the current child already published", async (t) => {
  const f = await fixture(t);
  const latest = JSON.stringify(CURRENT);
  await assert.rejects(
    f.run(`
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(join(f.state, CURRENT.runLog))}, "current run evidence");
      await writeFile(${JSON.stringify(join(f.state, "latest.json"))}, ${JSON.stringify(latest)});
      process.exitCode = 1;
    `),
    /exited 1.*[Ii]nspect/,
  );
  assert.equal(await readFile(join(f.state, "latest.json"), "utf8"), latest);
  assert.equal(await readFile(join(f.state, CURRENT.runLog), "utf8"), "current run evidence");
  assert.equal(await readFile(join(f.state, PRIOR.runLog), "utf8"), f.priorLog);
});

test("rejects unusable current output and preserves the prior evidence", async (t) => {
  const invalid = [
    ["empty successful child", ""],
    ["malformed JSON", "{broken"],
    ["partial digest", JSON.stringify({ verdict: "green" })],
    ["stdout noise", `diagnostic\n${JSON.stringify(CURRENT)}`],
    ["multiple replies", `${JSON.stringify(CURRENT)}\n${JSON.stringify(CURRENT)}`],
    ["scalar JSON", "null"],
    ["yellow worker", JSON.stringify({ ...CURRENT, verdict: "yellow" })],
    ["empty message", JSON.stringify({ ...CURRENT, message: " " })],
    ["invalid timestamp", JSON.stringify({ ...CURRENT, timestamp: "yesterday" })],
    ["object timestamp", JSON.stringify({ ...CURRENT, timestamp: { toString: null } })],
    ["noncanonical timestamp", JSON.stringify({ ...CURRENT, timestamp: "2026-10-22" })],
    ["absolute run log", JSON.stringify({ ...CURRENT, runLog: "/logs/current.json" })],
    ["traversing run log", JSON.stringify({ ...CURRENT, runLog: "logs/../other.json" })],
    ["unrelated run log", JSON.stringify({ ...CURRENT, runLog: "other/current.json" })],
    ["nested run log", JSON.stringify({ ...CURRENT, runLog: "logs/nested/current.json" })],
    ["non-JSON run log", JSON.stringify({ ...CURRENT, runLog: "logs/current.txt" })],
  ];
  for (const [name, reply] of invalid) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        f.run(`process.stdout.write(${JSON.stringify(reply)})`),
        /exited 0.*[Ii]nspect/,
      );
      await assertPriorRetained(f);
    });
  }
});

test("rejects exit contradictions and signals even after a valid reply", async (t) => {
  for (const [name, source, ending] of [
    ["green exit 1", printDigest(CURRENT, 1), /exited 1/],
    ["red exit 0", printDigest({ ...CURRENT, verdict: "red" }), /exited 0/],
    ["green exit 2", printDigest(CURRENT, 2), /exited 2/],
    ["signal without reply", 'process.kill(process.pid, "SIGTERM")', /SIGTERM/],
    [
      "signal after reply",
      `process.stdout.write(${JSON.stringify(JSON.stringify(CURRENT))}, () => process.kill(process.pid, "SIGTERM"));`,
      /SIGTERM/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await assert.rejects(f.run(source), (error) => {
        assert.match(error.message, ending);
        assert.match(error.message, /[Ii]nspect/);
        return true;
      });
      await assertPriorRetained(f);
    });
  }
});

test("drains oversized child output through close before reporting failure", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "drained");
  await assert.rejects(
    f.run(`
      import { writeFile } from "node:fs/promises";
      await new Promise((done) => process.stdout.write("x".repeat(4 * 1024 * 1024), done));
      await writeFile(${JSON.stringify(marker)}, "child finished writing");
    `),
    /exited 0.*[Ii]nspect/,
  );
  assert.equal(await readFile(marker, "utf8"), "child finished writing");
  await assertPriorRetained(f);
});

test("preserves UTF-8 split across child writes and rejects invalid UTF-8", async (t) => {
  const f = await fixture(t);
  const digest = { ...CURRENT, message: "synced 🧪 中文 ü" };
  const bytes = Buffer.from(JSON.stringify(digest));
  const split = bytes.indexOf(Buffer.from("🧪")) + 1;
  const result = await f.run(`
    import { Buffer } from "node:buffer";
    import { setTimeout } from "node:timers/promises";
    const bytes = Buffer.from(${JSON.stringify([...bytes])});
    process.stdout.write(bytes.subarray(0, ${split}));
    await setTimeout(10);
    process.stdout.write(bytes.subarray(${split}, ${split + 2}));
    await setTimeout(10);
    process.stdout.write(bytes.subarray(${split + 2}));
  `);
  assert.deepEqual(result, { digest, exitCode: 0 });
  const invalid = Buffer.from(JSON.stringify(CURRENT));
  invalid[invalid.indexOf(Buffer.from(CURRENT.message))] = 0xff;
  await assert.rejects(
    f.run(
      `import { Buffer } from "node:buffer"; process.stdout.write(Buffer.from(${JSON.stringify([...invalid])}));`,
    ),
    /exited 0.*[Ii]nspect/,
  );
  await assertPriorRetained(f);
});

test("exit 75 remains a yellow skipped run with no worker attempt", async (t) => {
  const f = await fixture(t);
  const result = await f.run("process.exitCode = 75");
  assert.equal(result.exitCode, 0);
  assert.equal(result.digest.verdict, "yellow");
  assert.deepEqual(JSON.parse(await readFile(join(f.state, "latest.json"), "utf8")), result.digest);
  const run = JSON.parse(await readFile(join(f.state, result.digest.runLog), "utf8"));
  assert.equal(run.attempts, 0);
  assert.deepEqual(run.preChecks, { lockHeld: true });
  assert.equal(run.sync, null);
  assert.equal(run.verify, null);
  assert.equal(await readFile(join(f.state, PRIOR.runLog), "utf8"), f.priorLog);
});

test("a lock spawn error reports the current failure and preserves prior evidence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runWatchdog({
      config: f.config,
      root: f.root,
      runner: {
        spawn: boundedSpawn,
        lock: () => ({ command: join(f.root, "missing-lock-command"), argumentsFor: [] }),
      },
    }),
    (error) => {
      assert.match(error.message, /ENOENT/);
      assert.match(error.message, /[Cc]heck|[Ii]nspect/);
      return true;
    },
  );
  await assertPriorRetained(f);
});

async function runInternalCli(f) {
  const configPath = join(f.root, "courses.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...f.config,
      driveMountPath: join(f.root, "missing-drive"),
      profilePath: join(f.root, "unused-profile"),
    }),
  );
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, "watchdog-locked"],
      {
        cwd: dirname(CLI),
        env: { ...process.env, NTULEARN_CONFIG_PATH: configPath },
        timeout: 5_000,
        maxBuffer: 65_536,
      },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("the internal CLI replies only after its digest is durably published", async (t) => {
  await t.test("successful publication", async (t) => {
    const f = await fixture(t);
    const result = await runInternalCli(f);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const digest = JSON.parse(result.stdout);
    assert.equal(digest.verdict, "red");
    assert.deepEqual(JSON.parse(await readFile(join(f.state, "latest.json"), "utf8")), digest);
    const run = JSON.parse(await readFile(join(f.state, digest.runLog), "utf8"));
    assert.equal(run.attempts, 0);
    assert.equal(run.preChecks.driveMount.present, false);
  });
  await t.test("latest publication failure", async (t) => {
    const f = await fixture(t);
    await rm(join(f.state, "latest.json"));
    await mkdir(join(f.state, "latest.json"));
    const sentinel = join(f.state, "latest.json", "retained");
    await writeFile(sentinel, "earlier evidence");
    const result = await runInternalCli(f);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /EISDIR|ENOTDIR|EEXIST|EPERM/);
    assert.equal(await readFile(sentinel, "utf8"), "earlier evidence");
    assert.equal(await readFile(join(f.state, PRIOR.runLog), "utf8"), f.priorLog);
    assert.equal((await readdir(join(f.state, "logs"))).length, 2);
  });
});
