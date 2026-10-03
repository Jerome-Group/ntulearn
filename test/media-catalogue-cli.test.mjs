import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { capabilityIndex } from "../src/capabilities/index.mjs";
for (const args of [
  ["inspect", "extra"],
  ["publish", "fake.json"],
  ["plan"],
  ["verify", "fake.json", "extra"],
  ["inspect"],
])
  test(`catalogue CLI bounded private-safe rejection: ${args.join(" ")}`, async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-catalogue-cli-")));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ["src/cli.mjs", "media-catalogue", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        NTULEARN_CONFIG_PATH: join(fixture, "owned-absent-config.json"),
      },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "blocked");
    assert.doesNotMatch(result.stdout, /owned-absent|fake\.json/);
  });
test("fresh capability index describes every phase, token, private report and offline feature checks", () => {
  const index = capabilityIndex("transcript-catalogue"),
    command = index.commands[0];
  assert.equal(command.machineInvocation, "npm run --silent media:catalogue");
  assert.deepEqual(Object.keys(command.operations), ["inspect", "plan", "publish", "verify"]);
  assert.equal(command.operations.inspect.output, "private-catalogue-metadata-v1");
  assert.ok(command.operations.publish.prerequisites.includes("PUBLISH_TRANSCRIPT_CATALOGUE"));
  for (const phase of Object.values(command.operations)) {
    assert.equal(phase.network, false);
    assert.equal(phase.browser, false);
    assert.equal(phase.runtime, false);
  }
});
