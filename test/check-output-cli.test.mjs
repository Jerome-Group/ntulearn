import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHECK_CAPTURE_BYTES } from "../src/capabilities/check-capture.mjs";

async function runFormatFixture(t, source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-check-output-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  await cp(fileURLToPath(new URL("../package.json", import.meta.url)), join(root, "package.json"));
  await mkdir(join(root, "node_modules/prettier/bin"), { recursive: true });
  await writeFile(join(root, "node_modules/prettier/bin/prettier.cjs"), source);
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [
        join(root, "src/cli.mjs"),
        "check",
        "format",
        "--evidence",
        ".scratch/check-evidence-output",
      ],
      {
        cwd: root,
        env: { ...process.env, NTULEARN_CONFIG_PATH: join(root, "absent-config.json") },
        timeout: 10000,
        maxBuffer: 65536,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout),
    check = report.checks.find((item) => item.id === "format");
  return {
    ...result,
    check,
    fixtureFile: (name) => readFile(join(root, name)),
    evidenceFile: (name) => readFile(join(root, ".scratch/check-evidence-output", name)),
  };
}

for (const stream of ["stdout", "stderr"]) {
  test(`native check preserves UTF-8 split across ${stream} chunks`, async (t) => {
    const result = await runFormatFixture(
      t,
      `const bytes = Buffer.from("€");
process.${stream}.write(bytes.subarray(0, 1));
setTimeout(() => { process.${stream}.write(bytes.subarray(1)); process.exitCode = 9; }, 80);`,
    );
    assert.equal(result.code, 1);
    assert.equal(result.check.evidence.exitCode, 9);
    const raw = await result.evidenceFile(`format-001.${stream}.log`),
      digest = createHash("sha256").update(raw).digest("hex");
    assert.deepEqual(raw, Buffer.from("€"));
    assert.equal(result.check.evidence.outputBytes, raw.length);
    assert.equal(result.check.evidence.outputSha256, digest);
    assert.equal(result.check.evidence.privateEvidence.streams[stream].capturedSha256, digest);
  });

  test(`native check stops ${stream} above the byte limit`, async (t) => {
    const result = await runFormatFixture(
      t,
      `const fs = require("node:fs");
fs.writeFileSync("child.pid", String(process.pid));
process.${stream}.write("€".repeat(750000));
setTimeout(() => fs.writeFileSync("completed", "yes"), 1000);`,
    );
    assert.equal(result.code, 1);
    assert.equal(result.check.code, "CHECK_FAILED");
    assert.notEqual(result.check.evidence.exitCode, 0);
    const proof = result.check.evidence.privateEvidence.streams[stream],
      raw = await result.evidenceFile(`format-001.${stream}.log`);
    assert.ok(proof.capturedBytes > CHECK_CAPTURE_BYTES);
    assert.equal(raw.length, CHECK_CAPTURE_BYTES);
    assert.equal(proof.truncated, true);
    assert.equal(proof.sha256, createHash("sha256").update(raw).digest("hex"));
    assert.ok(result.check.evidence.outputBytes <= CHECK_CAPTURE_BYTES);
    assert.equal(result.check.evidence.timedOut, false);
    await assert.rejects(result.fixtureFile("completed"), { code: "ENOENT" });
    const pid = Number(await result.fixtureFile("child.pid"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("native check accepts the exact byte limit independently for both streams", async (t) => {
  const result = await runFormatFixture(
    t,
    `process.stdout.write("A".repeat(${CHECK_CAPTURE_BYTES}));
process.stderr.write("B".repeat(${CHECK_CAPTURE_BYTES}));`,
  );
  assert.equal(result.code, 0);
  assert.equal(result.check.code, "CHECK_PASSED");
  assert.equal(result.check.evidence.outputBytes, 2 * CHECK_CAPTURE_BYTES);
  assert.equal(
    result.check.evidence.outputSha256,
    createHash("sha256")
      .update(Buffer.alloc(CHECK_CAPTURE_BYTES, 65))
      .update(Buffer.alloc(CHECK_CAPTURE_BYTES, 66))
      .digest("hex"),
  );
});
