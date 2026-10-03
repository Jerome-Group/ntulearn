import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { readRecoveryManifest, assertRecoveryInputs } from "../src/media/recovery-manifest.mjs";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { incompleteRecoveryFixture } from "./fixtures/media-recovery.mjs";

test("explicit state-owned unformatted source pins absent metadata/derivative and preserves queue on repeat publication", async (t) => {
  const f = await incompleteRecoveryFixture(t),
    before = await readFile(f.queuePath);
  const stateBefore = await readFile(f.statePath);
  const m = await readRecoveryManifest(f.options);
  assert.equal(m.recordings[0].authority, "state-owned-unformatted");
  assert.equal(m.recordings[0].original.absent, true);
  assert.equal(m.protectedAbsences.length, 2);
  await assertRecoveryInputs(m);
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
    "passed",
  );
  const published = await recoverTranscriptSources(
    { ...f.options, mode: "publish" },
    f.dependencies,
  );
  assert.equal(published.status, "passed");
  assert.equal(published.evidence.written, 5);
  const repeat = await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(repeat.status, "passed");
  assert.equal(repeat.evidence.existing, 5);
  assert.deepEqual(await readFile(f.queuePath), before);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
  assert.deepEqual(await readFile(f.statePath), stateBefore);
  for (const absent of [
    f.originalPath,
    f.metadataPath,
    f.course.destination + "/lecture.media-status.md",
  ])
    await assert.rejects(readFile(absent), { code: "ENOENT" });
  const provenanceName = (await readdir(f.course.destination)).find((name) =>
    name.endsWith(".provenance.json"),
  );
  const provenance = JSON.parse(await readFile(f.course.destination + "/" + provenanceName));
  assert.equal(provenance.authority, "state-owned-unformatted");
  assert.equal(provenance.originalDerivative.absent, true);
  assert.equal(provenance.originalDerivative.sha256, undefined);
  assert.equal(provenance.acousticVerification, "unrun");
});

test("absence is explicit; occupied originals/metadata and completed-source missing files never fall back", async (t) => {
  const { writeFile, rm } = await import("node:fs/promises");
  const { recoveryFixture } = await import("./fixtures/media-recovery.mjs");
  for (const field of ["original", "metadata"]) {
    const f = await incompleteRecoveryFixture(t),
      target = field === "original" ? f.originalPath : f.metadataPath;
    await writeFile(target, "Owner file; preserve");
    await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_ABSENCE_OCCUPIED" });
    assert.equal(await readFile(target, "utf8"), "Owner file; preserve");
  }
  const f = await incompleteRecoveryFixture(t);
  delete f.manifest.recordings[0].authority;
  await f.saveManifest();
  await assert.rejects(readRecoveryManifest(f.options));
  const g = await recoveryFixture(t);
  await rm(g.originalPath);
  await assert.rejects(readRecoveryManifest(g.options));
});

test("absence pins refuse appearances, dangling symlinks and replaced parent authority", async (t) => {
  const { writeFile, symlink, rename, mkdir } = await import("node:fs/promises");
  for (const targetKind of ["metadata", "original", "dangling"]) {
    const f = await incompleteRecoveryFixture(t),
      m = await readRecoveryManifest(f.options);
    const target = targetKind === "metadata" ? f.metadataPath : f.originalPath;
    if (targetKind === "dangling") await symlink(target + ".missing", target);
    else await writeFile(target, "late Owner file");
    await assert.rejects(assertRecoveryInputs(m), { code: "RECOVERY_ABSENCE_OCCUPIED" });
  }
  const f = await incompleteRecoveryFixture(t),
    m = await readRecoveryManifest(f.options);
  await rename(f.course.destination, f.course.destination + ".old");
  await mkdir(f.course.destination);
  await assert.rejects(assertRecoveryInputs(m), { code: "RECOVERY_INPUT_CHANGED" });
});

test("stale state/queue/raw/media bytes and ambiguous/foreign claims refuse admission", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  for (const target of ["statePath", "queuePath", "sourcePath"]) {
    const f = await incompleteRecoveryFixture(t);
    await writeFile(f[target], (await readFile(f[target], "utf8")) + " ");
    await assert.rejects(readRecoveryManifest(f.options));
  }
  const f = await incompleteRecoveryFixture(t);
  await writeFile(f.manifest.recordings[0].media.path, "changed media");
  await assert.rejects(readRecoveryManifest(f.options), { code: "RECOVERY_INPUT_CHANGED" });
  for (const change of [
    { disposition: "unresolved" },
    { withdrawn: true },
    { courseId: "foreign" },
    { sourceSha256: "0".repeat(64) },
    { sourceSha256: undefined },
    { artifacts: {} },
    { artifacts: { rawTranscript: "foreign" } },
    { complete: true },
    { formattedSha256: "0".repeat(64) },
  ]) {
    const g = await incompleteRecoveryFixture(t);
    await g.saveQueue([{ ...g.job, ...change }]);
    g.manifest.recordings[0].authority.queue.sha256 = (
      await import("./fixtures/media-recovery.mjs")
    ).digest(await readFile(g.queuePath));
    await g.saveManifest();
    await assert.rejects(readRecoveryManifest(g.options));
  }
  const g = await incompleteRecoveryFixture(t);
  await g.saveQueue([g.job, g.job]);
  await assert.rejects(readRecoveryManifest(g.options), { code: "RECOVERY_ASSOCIATION_AMBIGUOUS" });
});

test("late absence changes under locking or after recognition retain candidates but refuse publication", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const f = await incompleteRecoveryFixture(t);
  let jobs = 0;
  const deps = {
    ...f.dependencies,
    lock: async ({ run }) => {
      await writeFile(f.originalPath, "appeared before lock");
      return run();
    },
    runProcess: async () => {
      jobs++;
    },
  };
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, deps)).status,
    "failed",
  );
  assert.equal(jobs, 0);
  const g = await incompleteRecoveryFixture(t);
  const run = await recoverTranscriptSources(
    { ...g.options, mode: "run" },
    {
      ...g.dependencies,
      afterReportRetained: async () => writeFile(g.metadataPath, "appeared after recognition"),
    },
  );
  assert.equal(run.status, "failed");
  assert.ok(await readFile(g.outputDirectory + "/recording-1.native-asr.json"));
  assert.equal(
    (await recoverTranscriptSources({ ...g.options, mode: "publish" }, g.dependencies)).status,
    "failed",
  );
});

test("suspect/malformed candidates and unknown cleanup retain incomplete evidence without changing queues", async (t) => {
  const { mediaSafetyPath } = await import("../src/media/safety.mjs");
  for (const native of [
    { language: "en", segments: [{ start: 0, end: 20, text: "loop ".repeat(100) }] },
    {
      language: "en",
      segments: [
        { start: 0, end: 20, text: "valid source" },
        { start: 25, end: 22, text: "invalid timing" },
      ],
    },
  ]) {
    const f = await incompleteRecoveryFixture(t),
      before = await readFile(f.queuePath);
    Object.assign(f.native, native);
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
      "blocked",
    );
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
      "blocked",
    );
    assert.deepEqual(await readFile(f.queuePath), before);
    await assert.rejects(readFile(f.originalPath), { code: "ENOENT" });
  }
  const f = await incompleteRecoveryFixture(t),
    before = await readFile(f.queuePath);
  const failure = await recoverTranscriptSources(
    { ...f.options, mode: "run" },
    {
      ...f.dependencies,
      runProcess: async () => {
        throw Object.assign(new Error("fixture cleanup"), {
          code: "MEDIA_PROCESS_CLEANUP",
          globalSafety: true,
        });
      },
    },
  );
  assert.equal(failure.status, "blocked");
  assert.ok(await readFile(mediaSafetyPath(f.config.statePath)));
  assert.deepEqual(await readFile(f.queuePath), before);
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
    "blocked",
  );
});

test("publication races and interruption preserve exclusive partial outputs and refusal to overwrite", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const f = await incompleteRecoveryFixture(t);
  await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  const partial = await recoverTranscriptSources(
    { ...f.options, mode: "publish" },
    {
      ...f.dependencies,
      afterOutput: async ({ written }) => {
        if (written === 1) throw new Error("fixture interruption");
      },
    },
  );
  assert.equal(partial.status, "failed");
  assert.equal(partial.evidence.written, 1);
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const g = await incompleteRecoveryFixture(t);
  await recoverTranscriptSources({ ...g.options, mode: "run" }, g.dependencies);
  const race = await recoverTranscriptSources(
    { ...g.options, mode: "publish" },
    {
      ...g.dependencies,
      afterOutput: async ({ written }) => {
        if (written === 1) await writeFile(g.originalPath, "Owner edit appeared");
      },
    },
  );
  assert.equal(race.status, "failed");
  assert.equal(race.evidence.written, 1);
  assert.equal(await readFile(g.originalPath, "utf8"), "Owner edit appeared");
});

test("contradictory absent proof, disabled course and mismatched storage authority refuse", async (t) => {
  for (const mutate of [
    (f) => {
      f.manifest.recordings[0].authority.original.sha256 = "0".repeat(64);
    },
    (f) => {
      f.course.mediaMode = "off";
    },
    (f) => {
      f.job.storageSurface = "media-gallery";
    },
    (f) => {
      f.job.stage = "withdrawn";
    },
    (f) => {
      f.manifest.recordings[0].authority.kind = "automatic-fallback";
    },
  ]) {
    const f = await incompleteRecoveryFixture(t);
    mutate(f);
    await f.saveQueue();
    f.manifest.recordings[0].authority.queue.sha256 = (
      await import("./fixtures/media-recovery.mjs")
    ).digest(await readFile(f.queuePath));
    await f.saveManifest();
    await assert.rejects(readRecoveryManifest(f.options));
  }
});

test("changed checkpoint authority, missing media ownership and finite budgets refuse without recognition", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { digest } = await import("./fixtures/media-recovery.mjs");
  for (const change of [
    { recordingId: "content-tree:_1_1:foreign" },
    { sourceSha256: "0".repeat(64) },
    { sourceSha256: undefined },
    { artifacts: {} },
    { artifacts: { rawTranscript: "foreign" } },
    { media: { video: { available: false } } },
    { complete: true },
    { formattedSha256: "0".repeat(64) },
    { safetyFailure: "MEDIA_PROCESS_CLEANUP" },
  ]) {
    const f = await incompleteRecoveryFixture(t),
      state = JSON.parse(await readFile(f.statePath));
    await writeFile(f.statePath, JSON.stringify({ ...state, ...change }));
    f.manifest.recordings[0].authority.state.sha256 = digest(await readFile(f.statePath));
    await f.saveManifest();
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
      "failed",
    );
    assert.equal(f.calls.length, 0);
  }
  const f = await incompleteRecoveryFixture(t);
  f.manifest.budgets.maxInputBytes = 1;
  await f.saveManifest();
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(f.calls.length, 0);
});

test("Owner interruption retains source/queue and bounded recovery receipt without publication", async (t) => {
  const f = await incompleteRecoveryFixture(t),
    before = await readFile(f.queuePath),
    controller = new globalThis.AbortController();
  const run = await recoverTranscriptSources(
    { ...f.options, mode: "run", signal: controller.signal },
    {
      ...f.dependencies,
      runProcess: async (...args) => {
        const result = await f.dependencies.runProcess(...args);
        if (args[2]?.label === "Whisper transcription")
          controller.abort(
            Object.assign(new Error("owned fixture interruption"), { code: "MEDIA_INTERRUPTED" }),
          );
        return result;
      },
    },
  );
  assert.notEqual(run.status, "passed");
  assert.deepEqual(await readFile(f.queuePath), before);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
  await assert.rejects(readFile(f.originalPath), { code: "ENOENT" });
  assert.ok(await readFile(f.outputDirectory + "/recovery.json"));
});
