import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
