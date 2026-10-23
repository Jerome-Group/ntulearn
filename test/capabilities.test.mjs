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
  for (const feature of index.features)
    assert.equal(capabilityIndex(feature.id).features[0].id, feature.id);
  assert.deepEqual(capabilityIndex("sync").features[0].actions, ["npm run sync"]);
});

test("indexed check exposes explicit private evidence ownership, bounds and anonymous recovery", () => {
  const route = capabilityIndex("check").commands[0];
  assert.ok(route.arguments.includes("[--evidence .scratch/check-evidence-<safe-name>]"));
  assert.equal(route.optionalEvidence.default, false);
  assert.equal(route.optionalEvidence.bounds.streamPrefixBytes, 2097152);
  assert.equal(route.optionalEvidence.bounds.files, 17);
  assert.equal(route.optionalEvidence.permissions.directory, "0700");
  assert.equal(route.optionalEvidence.permissions.files, "0600");
  assert.match(route.optionalEvidence.failure, /Original check failure unchanged/);
  assert.match(route.optionalEvidence.privacy, /Raw output, arguments, paths/);
  assert.ok(route.code.includes("src/capabilities/check-evidence.mjs"));
  assert.ok(route.verification.tests.includes("test/capability-check-cli.test.mjs"));
  assert.equal(route.effects.network, false);
  assert.equal(route.effects.browser, false);
});

test("renumber describes retained claims, folder refusals and its native verification routes", () => {
  const route = capabilityIndex("renumber").commands[0];
  assert.equal(route.effects.ownerOnly, true);
  assert.ok(route.effects.writes.includes("private-renumber-claims"));
  assert.match(route.renumberProtocol.publication, /never unlink or overwrite public endpoints/);
  assert.match(route.renumberProtocol.recovery, /Retain every failed capture/);
  assert.match(route.renumberProtocol.folders, /Refused/);
  assert.equal(route.renumberProtocol.limits.manifestBytes, 4096);
  assert.match(route.exitCodes[1], /recovery-claims/);
  assert.ok(route.code.includes("src/sync/renumber-files.mjs"));
  assert.ok(route.verification.tests.includes("test/renumber-files.test.mjs"));
  assert.ok(route.verification.tests.includes("test/cli.test.mjs"));
});
