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

test("explicit retry separates exceptional cleanup barriers from confirmed Owner retry mutation", () => {
  const route = capabilityIndex("media-retry").commands[0];
  assert.equal(route.effects.network, false);
  assert.equal(route.effects.browser, false);
  assert.equal(route.operations.plan.ownerOnly, false);
  assert.deepEqual(route.operations.plan.writes, ["cleanup-safety-barrier-on-uncertainty"]);
  assert.equal(route.operations.apply.ownerOnly, true);
  assert.ok(route.operations.apply.prerequisites.includes("literal-confirmation"));
  assert.ok(route.operations.apply.prerequisites.includes("media-queue-lock"));
  assert.equal(route.output, "capability-result-v1");
  assert.deepEqual(route.exitCodes, { 0: "passed", 1: "failed", 2: "blocked-or-unrun-or-usage" });
  assert.match(route.limitations[0], /no acquisition, transcription or completeness/);
});

test("source recovery separates read-only planning, private ASR candidates and Owner publication", () => {
  const route = capabilityIndex("transcript-source-recovery").commands[0];
  assert.equal(route.id, "media-recover");
  assert.equal(route.effects.network, false);
  assert.equal(route.effects.browser, false);
  assert.equal(route.operations.plan.ownerOnly, false);
  assert.deepEqual(route.operations.plan.writes, []);
  assert.equal(route.operations.run.ownerOnly, true);
  assert.equal(route.operations.run.runtime, true);
  assert.equal(route.operations.publish.ownerOnly, true);
  assert.equal(route.operations.publish.runtime, false);
  assert.equal(route.output, "capability-result-v1");
  assert.equal(route.machineInvocation, "npm run --silent media:recover");
});

test("production transcript route exposes zero-model formatting and durable review policy", () => {
  const { formatting } = capabilityIndex("transcripts").features[0];
  assert.equal(formatting.version, "source-paragraphs-v1");
  assert.equal(formatting.modelCalls, 0);
  assert.equal(formatting.reviewRequired.complete, false);
  assert.equal(formatting.reviewRequired.retryable, false);
  assert.equal(formatting.reviewRequired.queueOnlyClear, false);
  assert.match(formatting.limitations, /acoustic/);
});

test("source recovery indexes explicit unformatted authority and absence protections", () => {
  const route = capabilityIndex("transcript-source-recovery").commands[0];
  assert.equal(route.manifest.authorities.default, "metadata-owned-original");
  const variant = route.manifest.authorities["state-owned-unformatted"];
  assert.ok(variant.fields.includes("authority.state.sha256"));
  assert.ok(variant.fields.includes("authority.original.absent"));
  assert.equal(variant.fallback, false);
  assert.equal(variant.queueReadinessWrites, false);
  assert.match(variant.limits, /parent/);
  assert.ok(route.verification.tests.includes("test/media-recovery-incomplete.test.mjs"));
});

test("source recovery exposes closed decoder policies without changing the established example", () => {
  const route = capabilityIndex("transcript-source-recovery").commands[0];
  assert.equal(route.manifest.policy, "independent-context-v1");
  assert.deepEqual(route.manifest.supportedPolicies, [
    "independent-context-v1",
    "independent-context-nonspeech-v1",
    "independent-context-nonspeech-vad-v1",
  ]);
  assert.match(route.limitations[0], /no post-generation filtering/);
  const feature = capabilityIndex("transcript-source-recovery").features[0];
  assert.ok(feature.verification.tests.includes("test/media-recovery-policy.test.mjs"));
});

test("optional VAD setup index preserves base receipt and points to offline qualification", () => {
  const setup = capabilityIndex("media-runtime").commands.find(
    (command) => command.id === "media-setup",
  );
  assert.deepEqual(setup.arguments, ["[vad]"]);
  assert.equal(setup.optionalVad.baseManifestWrites, false);
  assert.equal(setup.optionalVad.policy, "independent-context-nonspeech-vad-v1");
  assert.equal(setup.optionalVad.model.bytes, 885098);
  assert.match(setup.optionalVad.limits, /can omit speech/);
  const recovery = capabilityIndex("transcript-source-recovery").commands[0];
  assert.ok(recovery.verification.tests.includes("test/media-vad.test.mjs"));
  assert.match(recovery.operations.publish.optionalVadRuntime, /VAD policy only/);
});

test("media discovery indexes owned course isolation, safety admission and truthful partial reports", () => {
  const route = capabilityIndex("media-discover").commands[0];
  assert.ok(route.prerequisites.includes("safe-media-admission"));
  assert.ok(route.effects.writes.includes("cleanup-safety-barrier"));
  assert.match(route.courseContexts, /positive closure/);
  assert.match(route.report, /notAttempted/);
  assert.equal(route.exitCodes.incompleteOrInterrupted, 1);
  assert.equal(route.exitCodes.runtimeRefused, 1);
  assert.equal(route.exitCodes.usage, 2);
  assert.ok(route.code.includes("src/media/discover-run.mjs"));
  assert.ok(route.verification.tests.includes("test/media-discover-cli.test.mjs"));
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
