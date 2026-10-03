import assert from "node:assert/strict";
import test from "node:test";
import { capabilityIndex } from "../src/capabilities/index.mjs";

test("capabilities classify every supported script and resolve feature verification routes", async () => {
  const index = capabilityIndex();
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.configuration.overrideEnvironmentVariable, "NTULEARN_CONFIG_PATH");
  assert.equal(index.configuration.defaultFile, "config/courses.json");
  assert.ok(index.outputContracts["capability-result-v1"].fields.includes("checks"));
  assert.equal(new Set(index.commands.map((entry) => entry.id)).size, index.commands.length);
  for (const entry of index.commands) {
    assert.equal(entry.machineInvocation, `npm run --silent ${entry.script}`);
    assert.equal(typeof entry.effects.network, "boolean");
    assert.equal(typeof entry.effects.ownerOnly, "boolean");
    assert.ok(Array.isArray(entry.prerequisites));
    assert.ok(entry.verification.tests.length);
    assert.ok(entry.code.length);
  }
  assert.equal(capabilityIndex("verify").commands[0].effects.ownerOnly, true);
  assert.deepEqual(capabilityIndex("verify").commands[0].effects.writes, []);
  assert.throws(() => capabilityIndex("missing"), /capabilities/);
  assert.equal(capabilityIndex("transcripts").features[0].id, "transcripts");
  for (const feature of index.features)
    assert.equal(capabilityIndex(feature.id).features[0].id, feature.id);
  assert.deepEqual(capabilityIndex("transcripts").features[0].actions, ["npm run media:worker"]);
});

test("historical route distinguishes plan creation from Owner apply and read-only verify", () => {
  const route = capabilityIndex("historical-transcripts").commands[0];
  assert.equal(route.effects.ownerOnly, false);
  assert.equal(route.prerequisites.includes("private-historical-manifest"), false);
  assert.equal(route.operations.plan.ownerOnly, false);
  assert.equal(route.operations.plan.prerequisites.includes("private-historical-manifest"), false);
  assert.deepEqual(route.operations.plan.writes, ["fresh-private-plan"]);
  assert.equal(route.operations.apply.ownerOnly, true);
  assert.ok(route.operations.apply.prerequisites.includes("private-historical-manifest"));
  assert.equal(route.operations.verify.ownerOnly, false);
  assert.deepEqual(route.operations.verify.writes, []);
});

test("explicit retry exposes read-only plan and confirmed Owner state mutation separately", () => {
  const route = capabilityIndex("media-retry").commands[0];
  assert.equal(route.effects.network, false);
  assert.equal(route.effects.browser, false);
  assert.equal(route.operations.plan.ownerOnly, false);
  assert.deepEqual(route.operations.plan.writes, []);
  assert.equal(route.operations.apply.ownerOnly, true);
  assert.ok(route.operations.apply.prerequisites.includes("literal-confirmation"));
  assert.ok(route.operations.apply.prerequisites.includes("media-queue-lock"));
  assert.equal(route.output, "capability-result-v1");
  assert.deepEqual(route.exitCodes, { 0: "passed", 1: "failed", 2: "blocked-or-unrun-or-usage" });
  assert.match(route.limitations[0], /no acquisition, transcription or completeness/);
});
