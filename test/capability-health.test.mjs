import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, symlink, writeFile, rm } from "node:fs/promises";
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
    courses: [{ destination }],
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

test("health accepts destination root aliases while retaining canonical Drive containment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-health-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "profile");
  const driveMountPath = join(root, "Drive");
  const destination = join(root, "course-alias");
  await mkdir(profilePath, { mode: 0o700 });
  await mkdir(join(driveMountPath, "course"), { recursive: true });
  await symlink(join(driveMountPath, "course"), destination);
  const config = { profilePath, driveMountPath, courses: [{ destination }] };
  const options = { root, nodeVersion: "26.4.0", load: async () => config };

  const ready = await localHealth(options);
  assert.equal(ready.status, "passed");
  assert.deepEqual(ready.checks.find((check) => check.id === "destinations").evidence, {
    configured: 1,
    reachable: 1,
  });
  assert.ok(!JSON.stringify(ready).includes(root));
  await rm(destination);
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), destination);
  assert.equal((await localHealth(options)).status, "blocked");
});

test("health rejects profile aliases and unavailable or non-directory destinations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-health-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "profile");
  const destination = join(root, "course");
  await mkdir(profilePath, { mode: 0o700 });
  const config = { profilePath, driveMountPath: null, courses: [{ destination }] };
  const options = { root, nodeVersion: "26.4.0", load: async () => config };
  const destinations = async () =>
    (await localHealth(options)).checks.find((check) => check.id === "destinations");
  assert.equal((await destinations()).status, "blocked");
  await symlink(join(root, "missing"), destination);
  assert.equal((await destinations()).status, "blocked");
  await rm(destination);
  await writeFile(destination, "retained original");
  assert.equal((await destinations()).status, "blocked");
  await rm(destination);
  await mkdir(destination);
  assert.equal((await destinations()).status, "passed");
  const alias = join(root, "profile-alias");
  await symlink(profilePath, alias);
  config.profilePath = alias;
  const unsafe = await localHealth(options);
  assert.equal(unsafe.checks.find((check) => check.id === "session-metadata").status, "failed");
});
