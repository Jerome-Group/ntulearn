import assert from "node:assert/strict";
import test from "node:test";
import { capabilityIndex } from "../src/capabilities/index.mjs";

test("capabilities classify every supported script and resolve feature verification routes", async () => {
  const index = capabilityIndex();
  assert.equal(index.schemaVersion, 1);
  assert.equal(new Set(index.commands.map((entry) => entry.id)).size, index.commands.length);
  for (const entry of index.commands) {
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
