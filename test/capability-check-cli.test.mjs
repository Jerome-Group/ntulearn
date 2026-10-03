import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-check-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  await mkdir(join(root, "test"));
  const source = join(root, "test/seeded.test.mjs"),
    bootstrap = join(root, "bootstrap.mjs");
  await writeFile(
    source,
    'import test from "node:test";import assert from "node:assert/strict";test("original assertion",()=>assert.equal(1,2,"private original failure"));',
  );
  await writeFile(
    bootstrap,
    `import playwright from ${JSON.stringify(pathToFileURL(require.resolve("playwright")).href)};playwright.chromium.launchPersistentContext=()=>{throw new Error("Forbidden browser launch")};await import(${JSON.stringify(pathToFileURL(join(root, "src/cli.mjs")).href)});`,
  );
  const environment = { ...process.env, NTULEARN_CONFIG_PATH: join(root, "absent-config") };
  delete environment.NODE_TEST_CONTEXT;
  return {
    root,
    source,
    run: (...args) =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [bootstrap, "check", ...args],
          {
            cwd: root,
            env: environment,
            timeout: 10000,
            maxBuffer: 65536,
          },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        ),
      ),
  };
}
test("real indexed CLI retains failed assertions privately and a fresh recovery never overwrites them", async (t) => {
  const f = await fixture(t);
  const failed = await f.run("test", "--evidence", ".scratch/check-evidence-failure");
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, "");
  const result = JSON.parse(failed.stdout),
    proof = result.checks.find((c) => c.id === "test").evidence.privateEvidence;
  assert.equal(proof.reference, "requested-private-evidence/test-001");
  assert.equal(proof.streams.stdout.truncated, false);
  const directory = join(f.root, ".scratch/check-evidence-failure"),
    assertion = await readFile(join(directory, "test-001.stdout.log"), "utf8");
  assert.match(assertion, /private original failure/);
  assert.match(assertion, /AssertionError/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.doesNotMatch(
    failed.stdout,
    /private original failure|ntulearn-check-cli-|check-evidence-failure/,
  );
  const occupied = await f.run("test", "--evidence", ".scratch/check-evidence-failure");
  assert.equal(occupied.code, 2);
  assert.equal(JSON.parse(occupied.stdout).checks[0].code, "CHECK_EVIDENCE_OCCUPIED");
  await writeFile(f.source, 'import test from "node:test";test("recovered fixture",()=>{});');
  const recovered = await f.run("test", "--evidence", ".scratch/check-evidence-recovered");
  assert.equal(recovered.code, 0);
  assert.equal(recovered.stderr, "");
  assert.equal(await readFile(join(directory, "test-001.stdout.log"), "utf8"), assertion);
  assert.equal(JSON.parse(recovered.stdout).evidence.privateEvidence.complete, true);
});
test("real CLI rejects evidence misuse before checks and the default creates no evidence directory", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["test", "--evidence"],
    ["test", "--evidence", ".data/chrome-profile"],
    ["test", "--evidence", "../foreign"],
    ["test", "--evidence", ".scratch/check-evidence-fixture", "extra"],
  ]) {
    const result = await f.run(...args);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "blocked");
  }
  await assert.rejects(lstat(join(f.root, ".scratch")), { code: "ENOENT" });
  const result = await f.run("test");
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).checks.find((c) => c.id === "test").code, "CHECK_FAILED");
  assert.equal(result.stderr, "");
  await assert.rejects(lstat(join(f.root, ".scratch")), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.root)).sort(), ["bootstrap.mjs", "src", "test"]);
});
