import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepositoryChecks } from "../src/capabilities/check.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("shared checks detect injected tool failures, run remaining checks, and recover", async () => {
  const invocations = [];
  const run = async (_command, args, options) => {
    invocations.push({ args, options });
    return { exitCode: args.includes("--test") ? 9 : 0, stdout: "fixture output", stderr: "" };
  };
  const failed = await runRepositoryChecks({ root: ROOT, node: "node", run });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.checks.find((check) => check.id === "test").evidence.exitCode, 9);
  assert.equal(failed.checks.find((check) => check.id === "lint").status, "passed");
  assert.ok(invocations.every(({ options }) => options.timeout > 0 && options.timeout <= 120000));
  assert.ok(!JSON.stringify(failed).includes("fixture output"));
  const recovered = await runRepositoryChecks({
    root: ROOT,
    node: "node",
    run: async () => ({ exitCode: 0 }),
  });
  assert.equal(recovered.exitCode, 0);
});

test("check selection is bounded and reports unselected checks unrun", async () => {
  const result = await runRepositoryChecks({
    root: ROOT,
    selection: "syntax",
    node: "node",
    run: async () => ({ exitCode: 0 }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.checks
      .filter((check) => check.id !== "syntax")
      .every((check) => check.status === "unrun"),
  );
  assert.equal((await runRepositoryChecks({ root: ROOT, selection: "anything" })).exitCode, 2);
});

test("tool timeout is actionable and never reported as success", async () => {
  const result = await runRepositoryChecks({
    root: ROOT,
    selection: "test",
    node: "node",
    run: async () => ({ exitCode: 1, timedOut: true }),
  });
  const check = result.checks.find((value) => value.id === "test");
  assert.equal(check.status, "failed");
  assert.equal(check.code, "CHECK_TIMEOUT");
  assert.ok(check.action);
});

test("explicit private evidence retains the original failed assertion with an anonymous actionable reference", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-check-evidence-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".scratch/check-evidence-fixture");
  const assertion = "AssertionError: original private fixture assertion\n";
  const result = await runRepositoryChecks({
    root,
    selection: "test",
    node: "private-node-path",
    evidenceDirectory: directory,
    run: async () => ({ exitCode: 7, stdout: assertion, stderr: "private fixture stderr" }),
  });
  const check = result.checks.find((check) => check.id === "test");
  assert.equal(result.exitCode, 1);
  assert.equal(check.code, "CHECK_FAILED");
  assert.equal(check.evidence.exitCode, 7);
  assert.match(check.action, /requested private evidence directory/);
  assert.equal(await readFile(join(directory, "test-001.stdout.log"), "utf8"), assertion);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(directory, "test-001.stdout.log"))).mode & 0o777, 0o600);
  assert.doesNotMatch(
    JSON.stringify(result),
    /original private fixture assertion|private-node-path|ntulearn-check-evidence-/,
  );
});
