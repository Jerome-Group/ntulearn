import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  symlink,
  lstat,
  open,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Buffer } from "node:buffer";
import { createCheckEvidence } from "../src/capabilities/check-evidence.mjs";
import { runRepositoryChecks, parseCheckArguments } from "../src/capabilities/check.mjs";
import { createCheckCapture, CHECK_CAPTURE_BYTES } from "../src/capabilities/check-capture.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-private-check-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, ".scratch/check-evidence-fixture") };
}
const failedRun = async () => ({
  exitCode: 9,
  stdout: "original fixture assertion",
  stderr: "private fixture stderr",
});
const invoke = (f, options = {}) =>
  runRepositoryChecks({
    root: f.root,
    node: "fixture-node",
    selection: "test",
    run: failedRun,
    evidenceDirectory: f.directory,
    evidenceOptions: options,
  });

test("check flags preserve all default/selection forms and reject malformed evidence options", () => {
  assert.deepEqual(parseCheckArguments([]), { selection: undefined });
  assert.deepEqual(parseCheckArguments(["syntax"]), { selection: "syntax" });
  assert.deepEqual(parseCheckArguments(["--evidence", ".scratch/check-evidence-a"]), {
    selection: undefined,
    evidenceDirectory: ".scratch/check-evidence-a",
  });
  assert.deepEqual(parseCheckArguments(["test", "--evidence", "target"]), {
    selection: "test",
    evidenceDirectory: "target",
  });
  for (const args of [
    ["test", "extra"],
    ["--evidence"],
    ["test", "--evidence", ""],
    ["test", "--evidence", "target", "extra"],
  ])
    assert.equal(parseCheckArguments(args), null);
});
for (const target of [
  "outside",
  ".data/chrome-profile/check-evidence-a",
  "runtime/check-evidence-a",
  ".scratch/nested/check-evidence-a",
  ".scratch/check-evidence-bad.name",
])
  test(`lexical target ${target} refuses before metadata or content operations`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    await assert.rejects(
      createCheckEvidence({
        root: f.root,
        directory: target,
        inspect: async () => {
          calls++;
        },
        canonical: async () => {
          calls++;
        },
        openFile: async () => {
          calls++;
        },
      }),
      { code: "CHECK_EVIDENCE_PATH" },
    );
    assert.equal(calls, 0);
  });
for (const shape of ["symlink-parent", "occupied", "symlink-target"])
  test(`evidence ${shape} refuses without content reads/opens or check execution`, async (t) => {
    const f = await fixture(t),
      foreign = join(f.root, "foreign");
    await mkdir(foreign);
    if (shape === "symlink-parent") await symlink(foreign, join(f.root, ".scratch"));
    else {
      await mkdir(join(f.root, ".scratch"));
      if (shape === "occupied") await mkdir(f.directory, { mode: 0o700 });
      else await symlink(foreign, f.directory);
    }
    let opens = 0,
      runs = 0;
    const result = await runRepositoryChecks({
      root: f.root,
      selection: "test",
      node: "fixture-node",
      evidenceDirectory: f.directory,
      run: async () => {
        runs++;
        return { exitCode: 0 };
      },
      evidenceOptions: {
        openFile: async () => {
          opens++;
        },
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(runs, 0);
    assert.equal(opens, 0);
    assert.equal(result.checks.find((c) => c.id === "test").status, "unrun");
    assert.deepEqual(await readdir(foreign), []);
  });
test("private evidence is exclusive; recovery uses a fresh directory and preserves earlier failure", async (t) => {
  const f = await fixture(t),
    failed = await invoke(f),
    original = await readFile(join(f.directory, "test-001.stdout.log"));
  assert.equal(
    failed.checks.find((c) => c.id === "test").evidence.privateEvidence.streams.stdout.sha256
      .length,
    64,
  );
  assert.equal(failed.evidence.privateEvidence.complete, true);
  assert.equal(
    JSON.parse(await readFile(join(f.directory, "run.result.json"))).evidenceStatus,
    "pending-final-settlement",
  );
  assert.equal((await lstat(join(f.directory, "test-001.invocation.json"))).mode & 0o777, 0o600);
  assert.equal((await invoke(f)).exitCode, 2);
  const fresh = join(f.root, ".scratch/check-evidence-recovery");
  const recovered = await runRepositoryChecks({
    root: f.root,
    selection: "test",
    node: "node",
    evidenceDirectory: fresh,
    run: async () => ({ exitCode: 0 }),
  });
  assert.equal(recovered.exitCode, 0);
  assert.deepEqual(await readFile(join(f.directory, "test-001.stdout.log")), original);
  assert.doesNotMatch(
    JSON.stringify(failed),
    /original fixture assertion|fixture-node|ntulearn-private-check-/,
  );
});
test("explicit overflow retains a bounded prefix with separate full-capture digest and no false success", async (t) => {
  const f = await fixture(t),
    capture = createCheckCapture();
  capture.append("stdout", Buffer.alloc(CHECK_CAPTURE_BYTES + 1, 65));
  const result = await runRepositoryChecks({
    root: f.root,
    selection: "test",
    node: "node",
    evidenceDirectory: f.directory,
    run: async () => ({
      exitCode: 4,
      stdout: "A".repeat(CHECK_CAPTURE_BYTES + 1),
      rawOutput: capture.result(),
    }),
  });
  const proof = result.checks.find((c) => c.id === "test").evidence.privateEvidence.streams.stdout;
  assert.equal(result.exitCode, 1);
  assert.equal(proof.bytes, CHECK_CAPTURE_BYTES);
  assert.equal(proof.capturedBytes, CHECK_CAPTURE_BYTES + 1);
  assert.equal(proof.truncated, true);
  assert.notEqual(proof.sha256, proof.capturedSha256);
  assert.equal((await lstat(join(f.directory, "test-001.stdout.log"))).size, CHECK_CAPTURE_BYTES);
});
for (const boundary of ["stat", "close", "parent"])
  test(`pending ${boundary} returns explicit cleanup uncertainty, preserves failure and cannot write late`, async (t) => {
    const f = await fixture(t);
    let release,
      entered,
      closed = false;
    const pending = new Promise((resolve) => {
        release = resolve;
      }),
      started = new Promise((resolve) => {
        entered = resolve;
      });
    let reached = false;
    const resultPromise = invoke(f, {
      ioMs: 200,
      settleMs: 50,
      inspect: async (path) => {
        if (boundary === "parent" && reached && path === f.directory) {
          entered();
          await pending;
        }
        return lstat(path);
      },
      openFile: async (...args) => {
        const handle = await open(...args);
        const affected = args[0].endsWith("test-001.stdout.log");
        if (affected) reached = true;
        return {
          stat: async () => {
            if (affected && boundary === "stat") {
              entered();
              await pending;
            }
            return handle.stat();
          },
          read: (...a) => handle.read(...a),
          writeFile: (...a) => handle.writeFile(...a),
          sync: () => handle.sync(),
          close: async () => {
            if (affected && boundary === "close") {
              entered();
              await pending;
            }
            await handle.close();
            if (affected) closed = true;
          },
        };
      },
    });
    t.after(() => release());
    await Promise.race([
      started,
      resultPromise.then(() => assert.fail("fixture did not reach the pending boundary")),
    ]);
    const result = await resultPromise;
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.find((c) => c.id === "test").evidence.exitCode, 9);
    assert.equal(
      result.checks.find((c) => c.id === "private-evidence").code,
      "CHECK_EVIDENCE_CLEANUP",
    );
    assert.equal(result.evidence.privateEvidence.complete, false);
    assert.equal(closed, false);
    await assert.rejects(lstat(join(f.directory, "run.result.json")), { code: "ENOENT" });
    release();
    await setTimeout(15);
    assert.equal(closed, true);
    await assert.rejects(lstat(join(f.directory, "test-001.stderr.log")), { code: "ENOENT" });
    assert.equal((await invoke(f)).exitCode, 2);
  });
test("close rejection remains cleanup failure even when another I/O deadline expires", async (t) => {
  const f = await fixture(t);
  const result = await invoke(f, {
    ioMs: 10,
    settleMs: 40,
    openFile: async (...args) => {
      const handle = await open(...args);
      return {
        stat: () => handle.stat(),
        read: (...a) => handle.read(...a),
        writeFile: (...a) => handle.writeFile(...a),
        sync: () => handle.sync(),
        close: async () => {
          await setTimeout(15);
          await handle.close();
          throw new Error("private cleanup failure");
        },
      };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks[0].code, "CHECK_EVIDENCE_CLEANUP");
  assert.doesNotMatch(JSON.stringify(result), /private cleanup failure/);
});
test("directory replacement before failed-output write refuses bytes in the foreign directory", async (t) => {
  const f = await fixture(t);
  let moved = false;
  const result = await invoke(f, {
    openFile: async (...args) => {
      if (args[0].endsWith("test-001.stdout.log") && !moved) {
        moved = true;
        await rename(f.directory, f.directory + "-retained");
        await mkdir(f.directory, { mode: 0o700 });
      }
      return open(...args);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((c) => c.id === "test").evidence.exitCode, 9);
  assert.equal(result.checks.find((c) => c.id === "private-evidence").code, "CHECK_EVIDENCE_PATH");
  assert.equal((await lstat(join(f.directory, "test-001.stdout.log"))).size, 0);
  await assert.rejects(lstat(join(f.directory, "run.result.json")), { code: "ENOENT" });
});
test("written bytes are verified; tampered same-size evidence cannot gain a confirmed digest", async (t) => {
  const f = await fixture(t);
  const result = await invoke(f, {
    openFile: async (...args) => {
      const handle = await open(...args),
        affected = args[0].endsWith("test-001.stdout.log");
      return {
        stat: () => handle.stat(),
        read: (...a) => handle.read(...a),
        writeFile: (bytes) => handle.writeFile(affected ? Buffer.alloc(bytes.length, 66) : bytes),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((c) => c.id === "test").evidence.exitCode, 9);
  assert.equal(result.checks.find((c) => c.id === "private-evidence").code, "CHECK_EVIDENCE_IO");
  assert.equal(result.evidence.privateEvidence.complete, false);
});

test("evidence bounds and foreign owner refuse before filesystem operations", async (t) => {
  const f = await fixture(t);
  let operations = 0;
  for (const options of [{ ioMs: 5001 }, { totalIoMs: 30001 }, { settleMs: 0 }]) {
    await assert.rejects(
      createCheckEvidence({
        ...f,
        ...options,
        inspect: async () => {
          operations++;
        },
      }),
      { code: "CHECK_EVIDENCE_BOUND" },
    );
  }
  assert.equal(operations, 0);
  const owner = (await lstat(f.root)).uid;
  await assert.rejects(createCheckEvidence({ ...f, ownerUid: owner + 1 }), {
    code: "CHECK_EVIDENCE_PATH",
  });
  await assert.rejects(lstat(join(f.root, ".scratch")), { code: "ENOENT" });
});
test("private execution exceptions are retained without public exception or invocation leakage", async (t) => {
  const f = await fixture(t);
  const result = await runRepositoryChecks({
    root: f.root,
    selection: "test",
    node: "private-node",
    evidenceDirectory: f.directory,
    run: async () => {
      throw new Error("private original exception");
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((c) => c.id === "test").code, "CHECK_EXECUTION_FAILED");
  assert.match(
    await readFile(join(f.directory, "test-001.stderr.log"), "utf8"),
    /private original exception/,
  );
  assert.doesNotMatch(JSON.stringify(result), /private original exception|private-node/);
});
