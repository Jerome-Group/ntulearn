import assert from "node:assert/strict";
import { writeFile, readFile, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { readRecoveryManifest, assertRecoveryInputs } from "../src/media/recovery-manifest.mjs";
import { recoveryFixture } from "./fixtures/media-recovery.mjs";

test("positive current source/media/derivative ownership yields protected hash evidence", async (t) => {
  const f = await recoveryFixture(t);
  const m = await readRecoveryManifest(f.options);
  assert.equal(m.recordings.length, 1);
  assert.equal(m.protectedInputs.length, 7);
  await assertRecoveryInputs(m);
  await writeFile(f.originalPath, "student edit");
  await assert.rejects(assertRecoveryInputs(m), { code: "RECOVERY_INPUT_CHANGED" });
});
test("missing source, source edits and symlink substitution refuse admission", async (t) => {
  const f = await recoveryFixture(t);
  await rm(f.sourcePath);
  await assert.rejects(readRecoveryManifest(f.options));
  await writeFile(f.sourcePath, "edited source");
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_INPUT_CHANGED" });
  await rm(f.sourcePath);
  await symlink(f.originalPath, f.sourcePath);
  await assert.rejects(readRecoveryManifest(f.options));
});
test("foreign, ambiguous, withdrawn and unresolved targets refuse positive association", async (t) => {
  const f = await recoveryFixture(t);
  await f.saveQueue([f.job, { ...f.job }]);
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_ASSOCIATION_AMBIGUOUS" });
  for (const change of [
    { withdrawn: true },
    { disposition: "unresolved" },
    { courseId: "foreign" },
  ]) {
    await f.saveQueue([{ ...f.job, ...change }]);
    await assert.rejects(readRecoveryManifest(f.options));
  }
  await f.saveQueue();
  f.manifest.recordings[0].courseKey = "FOREIGN";
  await f.saveManifest();
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_ASSOCIATION_INVALID" });
});
test("unowned media and edited original derivative never acquire ownership from a manifest", async (t) => {
  const f = await recoveryFixture(t);
  await writeFile(
    f.statePath,
    JSON.stringify({
      recordingId: f.job.recordingId,
      sourceSha256: f.manifest.recordings[0].source.sha256,
      artifacts: { media: f.originalPath },
    }),
  );
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_MEDIA_UNOWNED" });
  const g = await recoveryFixture(t);
  await writeFile(g.originalPath, "student edit");
  await assert.rejects(readRecoveryManifest(g.options), { code: "RECOVERY_ORIGINAL_EDITED" });
});

test("legacy retained state media corroborates ownership without a media artifact shortcut", async (t) => {
  const f = await recoveryFixture(t);
  const proof = JSON.parse(await readFile(f.metadataPath));
  await writeFile(f.statePath, JSON.stringify({ ...proof, artifacts: { media: null } }));
  assert.equal((await readRecoveryManifest(f.options)).recordings.length, 1);
  proof.media.video.available = false;
  await writeFile(f.metadataPath, JSON.stringify(proof));
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_MEDIA_UNOWNED" });
});

test("different retained identities claiming the same original derivative remain ambiguous", async (t) => {
  const f = await recoveryFixture(t);
  await f.saveQueue([f.job, { ...f.job, recordingId: "content-tree:_1_1:another" }]);
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_ASSOCIATION_AMBIGUOUS" });
});

test("queue logical authority refuses symlink aliases and late retargeting", async (t) => {
  const f = await recoveryFixture(t);
  const before = await readRecoveryManifest(f.options);
  const aliasTarget = f.queuePath + ".alternate";
  await writeFile(aliasTarget, await readFile(f.queuePath));
  await rm(f.queuePath);
  await symlink(aliasTarget, f.queuePath);
  await assert.rejects(readRecoveryManifest(f.options));
  await assert.rejects(assertRecoveryInputs(before));
  await rm(f.queuePath);
  await symlink(f.metadataPath, f.queuePath);
  await assert.rejects(assertRecoveryInputs(before));
});
