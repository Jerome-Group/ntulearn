import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { recoveryFixture, incompleteRecoveryFixture } from "./fixtures/media-recovery.mjs";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { VAD_RUNTIME, vadRuntimePin } from "../src/media/vad-model.mjs";
import { transcriptCatalogue } from "../src/media/catalogue.mjs";

async function published(t, factory = recoveryFixture, policy) {
  const f = await factory(t);
  if (policy) {
    f.manifest.policy = policy;
    await f.saveManifest();
  }
  if (policy === "independent-context-nonspeech-vad-v1") {
    const verifyRuntime = f.dependencies.verifyRuntime;
    f.dependencies.verifyRuntime = async (...args) => {
      const runtime = await verifyRuntime(...args);
      runtime.artifacts.push({ key: "asr.runtime", sha256: VAD_RUNTIME.sha256 });
      return runtime;
    };
    f.dependencies.verifyVad = async () => ({
      path: join(f.root, "fixture-vad.bin"),
      pin: vadRuntimePin(),
      inputs: [],
    });
  }
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
    "passed",
  );
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  return f;
}
for (const factory of [recoveryFixture, incompleteRecoveryFixture])
  test(`catalogue ${factory.name} retains generation proof but admits unrelated current queue progress`, async (t) => {
    const f = await published(t, factory),
      before = await readFile(f.sourcePath);
    const queued = JSON.parse(await readFile(f.queuePath));
    queued.updatedAt = "unrelated progress";
    await writeFile(f.queuePath, JSON.stringify(queued));
    const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(result.status, "passed");
    const recording = result.catalogue.courses[0].recordings[0];
    assert.equal(recording.preferred?.kind, "recovered");
    assert.equal(recording.preferred.timing, "passed");
    assert.equal(recording.sourceReview.acousticVerification, "unrun");
    assert.deepEqual(await readFile(f.sourcePath), before);
    // Recovery run/publication still refuses its original whole-queue stale pin.
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
      "failed",
    );
  });
test("changed raw and edited candidate/published/native evidence never becomes a preferred recovered edition", async (t) => {
  for (const kind of ["raw", "published", "native", "assessment"]) {
    const f = await published(t);
    const name = (await readdir(f.course.destination)).find((name) =>
      /\.recovered-.*\.md$/.test(name),
    );
    const path =
      kind === "raw"
        ? f.sourcePath
        : kind === "published"
          ? join(f.course.destination, name)
          : kind === "native"
            ? join(f.course.destination, name + ".native-asr.json")
            : join(f.outputDirectory, "recording-1.assessment.json");
    await writeFile(path, "Student edited evidence");
    const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(result.status, "passed");
    assert.equal(result.catalogue.courses[0].recordings[0].preferred, null);
    assert.equal(await readFile(path, "utf8"), "Student edited evidence");
  }
});
test("absence variant refuses newly occupied original and current raw ownership mismatch", async (t) => {
  for (const kind of ["occupied", "queue-sha", "state-sha", "media", "ambiguous"]) {
    const f = await published(t, incompleteRecoveryFixture);
    if (kind === "occupied") await writeFile(f.originalPath, "User original");
    if (kind === "media") await writeFile(f.manifest.recordings[0].media.path, "changed media");
    if (kind === "state-sha") {
      const state = JSON.parse(await readFile(f.statePath));
      delete state.sourceSha256;
      await writeFile(f.statePath, JSON.stringify(state));
    }
    if (kind === "queue-sha") {
      delete f.job.sourceSha256;
      await f.saveQueue();
    }
    if (kind === "ambiguous") await f.saveQueue([f.job, f.job]);
    const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(
      result.catalogue?.courses[0].recordings.some((record) => record.preferred),
      false,
    );
  }
});

test("media mutation/replacement between admission and journal publication refuses with retained partial evidence", async (t) => {
  for (const kind of ["mutate", "replace", "symlink"]) {
    const f = await published(t),
      { rename, symlink } = await import("node:fs/promises"),
      path = f.manifest.recordings[0].media.path;
    const options = { config: f.config, manifestPath: join(f.root, "catalogue.json") };
    assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
    let acted = false;
    const result = await transcriptCatalogue(
      { ...options, mode: "publish" },
      {
        ...f.dependencies,
        afterOutput: async () => {
          if (acted) return;
          acted = true;
          if (kind === "mutate") await writeFile(path, "modified fixture bytes");
          else {
            await rename(path, path + ".retained");
            if (kind === "replace") await writeFile(path, "fixture audio");
            else await symlink(path + ".retained", path);
          }
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.ok(result.evidence.written > 0);
    assert.equal(result.evidence.promoted, 0);
  }
});

for (const factory of [recoveryFixture, incompleteRecoveryFixture])
  test(`nonspeech catalogue ${factory.name} preserves selected policy and strict generation publication pins`, async (t) => {
    const policy = "independent-context-nonspeech-v1",
      f = await published(t, factory, policy);
    const original = await readFile(f.sourcePath),
      queue = JSON.parse(await readFile(f.queuePath));
    queue.updatedAt = "unrelated advancement";
    await writeFile(f.queuePath, JSON.stringify(queue));
    const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(result.status, "passed");
    assert.equal(result.catalogue.courses[0].recordings[0].preferred?.policy, policy);
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
      "failed",
    );
    assert.deepEqual(await readFile(f.sourcePath), original);
    const provenance = result.catalogue.courses[0].recordings[0].preferred.provenance;
    const proof = JSON.parse(await readFile(provenance));
    proof.policy = "independent-context-v1";
    await writeFile(provenance, JSON.stringify(proof));
    const changed = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(changed.catalogue.courses[0].recordings[0].preferred, null);
  });

for (const factory of [recoveryFixture, incompleteRecoveryFixture])
  test(`VAD catalogue ${factory.name} retains closed optional evidence and rejects mutually matching foreign pins`, async (t) => {
    const f = await published(t, factory, "independent-context-nonspeech-vad-v1");
    const initial = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(initial.catalogue.courses[0].recordings[0].preferred?.policy, f.manifest.policy);
    const provenancePath = initial.catalogue.courses[0].recordings[0].preferred.provenance;
    const reportPath = join(f.outputDirectory, "recovery.json");
    const originalReport = JSON.parse(await readFile(reportPath)),
      originalProvenance = JSON.parse(await readFile(provenancePath));
    for (const kind of [
      "missing",
      "model",
      "runtime",
      "controls",
      "revision",
      "bytes",
      "duplicate",
    ]) {
      const report = globalThis.structuredClone(originalReport),
        provenance = globalThis.structuredClone(originalProvenance);
      const pin = report.runtimePins.find((pin) => pin.key === "asr.vad");
      if (kind === "missing")
        report.runtimePins = report.runtimePins.filter((pin) => pin.key !== "asr.vad");
      if (kind === "model") pin.sha256 = "0".repeat(64);
      if (kind === "runtime")
        report.runtimePins.find((pin) => pin.key === "asr.runtime").sha256 = "0".repeat(64);
      if (kind === "controls") pin.controls[1] = "0.9";
      if (kind === "revision") pin.revision = "foreign";
      if (kind === "bytes") pin.bytes++;
      if (kind === "duplicate") report.runtimePins.push({ ...pin });
      provenance.runtimePins = report.runtimePins;
      await writeFile(reportPath, JSON.stringify(report));
      await writeFile(provenancePath, JSON.stringify(provenance));
      const changed = await transcriptCatalogue({ config: f.config, mode: "inspect" });
      assert.equal(changed.catalogue.courses[0].recordings[0].preferred, null, kind);
    }
    assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
  });

test("VAD and earlier-policy editions with identical prose require explicit catalogue selection", async (t) => {
  const f = await published(t, recoveryFixture, "independent-context-nonspeech-vad-v1");
  f.manifest.policy = "independent-context-nonspeech-v1";
  await f.saveManifest();
  const options = {
    ...f.options,
    outputDirectory: join(f.config.media.mediaRoot, "earlier-policy-candidate"),
  };
  assert.equal(
    (await recoverTranscriptSources({ ...options, mode: "run" }, f.dependencies)).status,
    "passed",
  );
  assert.equal(
    (await recoverTranscriptSources({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const inspected = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const recording = inspected.catalogue.courses[0].recordings[0];
  assert.equal(recording.preferred, null);
  assert.equal(recording.reason, "ambiguous-eligible-editions");
  assert.equal(
    new Set(
      recording.editions
        .filter((edition) => edition.eligible)
        .map((edition) => edition.equivalence),
    ).size,
    2,
  );
});
