import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkContracts } from "../src/capabilities/contracts.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("structural checks detect catalog drift and missing routes without suppressing other checks", async () => {
  const checks = await checkContracts(ROOT, {
    read: async () => JSON.stringify({ scripts: { surprise: "node missing.mjs" } }),
    exists: async () => {
      throw new Error("fixture absent");
    },
    inspect: async () => ({ isSymbolicLink: () => false }),
  });
  assert.equal(checks.length, 4);
  assert.ok(checks.every((check) => check.status === "failed"));
  assert.ok(checks.every((check) => check.action));
  assert.ok((await checkContracts(ROOT)).every((check) => check.status === "passed"));
});
