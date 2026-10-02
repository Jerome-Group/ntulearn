import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localHealth } from "../src/capabilities/health.mjs";

test("offline health observes metadata, detects failures and recovers without opening profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-health-"));
  const profilePath = join(root, "profile");
  const destination = join(root, "Drive", "course");
  const config = {
    profilePath,
    driveMountPath: join(root, "Drive"),
    courses: [{ destination, mediaMode: "off" }],
  };
  const options = { root, nodeVersion: "26.4.0", load: async () => config };
  const missing = await localHealth(options);
  assert.equal(missing.status, "blocked");
  await mkdir(profilePath, { mode: 0o700 });
  await mkdir(destination, { recursive: true });
  const ready = await localHealth(options);
  assert.equal(ready.status, "passed");
  assert.equal(ready.checks.find((check) => check.id === "session-validity").status, "unrun");
  assert.ok(!JSON.stringify(ready).includes(root));
  await chmod(profilePath, 0o755);
  assert.equal((await localHealth(options)).status, "failed");
  await chmod(profilePath, 0o700);
  assert.equal((await localHealth(options)).status, "passed");
  assert.equal((await localHealth({ ...options, nodeVersion: "23.2.0" })).status, "failed");
});

test("configuration diagnostics never expose private values or raw exceptions", async () => {
  const result = await localHealth({
    root: "/private/fixture",
    nodeVersion: "26.4.0",
    load: async () => {
      throw new Error("https://secret.example/?token=private");
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("/private/fixture"));
});
