import assert from "node:assert/strict";
import { readFile, writeFile, access, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProductionLocalModels } from "../src/media/production-local.mjs";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { recoveryFixture, digest } from "./fixtures/media-recovery.mjs";

async function interruptedPrefix(t, { review = false } = {}) {
  const f = await recoveryFixture(t);
  await f.addRecording();
  if (review) f.native.segments[0].text = "loop ".repeat(100).trim();
  const runProcess = f.dependencies.runProcess;
  let recognitions = 0;
  const failed = await recoverTranscriptSources(
    { ...f.options, mode: "run" },
    {
      ...f.dependencies,
      runProcess: async (...args) => {
        if (args[2].label === "Whisper transcription" && ++recognitions === 2)
          throw Object.assign(new Error("fixture interruption"), { code: "RECOVERY_INTERRUPTED" });
        return runProcess(...args);
      },
    },
  );
  assert.equal(failed.status, "failed");
  const previous = await readFile(join(f.outputDirectory, "recovery.json"));
  assert.equal(JSON.parse(previous).candidates.length, 1);
  f.resume = {
    ...f.options,
    mode: "resume",
    previousOutputDirectory: f.outputDirectory,
    previousReportSha256: digest(previous),
    outputDirectory: join(f.config.media.mediaRoot, "resumed"),
  };
  f.calls.length = 0;
  return f;
}

test("resume copies only reported prefix, reruns partial, retains failure ancestry and publishes idempotently", async (t) => {
  const f = await interruptedPrefix(t);
  const previous = await readFile(join(f.outputDirectory, "recovery.json"));
  const result = await recoverTranscriptSources(f.resume, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.reusedCandidates, 1);
  assert.equal(result.evidence.candidates, 2);
  assert.equal(f.calls.filter((call) => call.options?.label === "Whisper transcription").length, 1);
  assert.deepEqual(await readFile(join(f.outputDirectory, "recovery.json")), previous);
  const report = JSON.parse(await readFile(join(f.resume.outputDirectory, "recovery.json")));
  assert.deepEqual(report.resumeFrom, {
    reportSha256: digest(previous),
    runId: JSON.parse(previous).runId,
    failureCode: "RECOVERY_INTERRUPTED",
    reusedCandidates: 1,
  });
  assert.equal(report.failureCode, undefined);
  assert.equal(report.candidates.length, 2);
  assert.equal((await lstat(f.resume.outputDirectory)).mode & 0o777, 0o700);
  for (const file of report.candidates[0].files) {
    assert.deepEqual(
      await readFile(join(f.resume.outputDirectory, file.name)),
      await readFile(join(f.outputDirectory, file.name)),
    );
    assert.equal((await lstat(join(f.resume.outputDirectory, file.name))).mode & 0o777, 0o600);
  }
  const publish = { ...f.options, mode: "publish", outputDirectory: f.resume.outputDirectory };
  assert.equal((await recoverTranscriptSources(publish, f.dependencies)).status, "passed");
  assert.equal((await recoverTranscriptSources(publish, f.dependencies)).evidence.written, 0);
  const repeat = await recoverTranscriptSources(f.resume, f.dependencies);
  assert.equal(repeat.status, "failed");
  assert.equal(
    repeat.checks.some((check) => check.code === "RECOVERY_FAILED"),
    true,
  );
});

for (const change of ["report", "candidate", "runtime", "source", "nonprefix", "partial-proof"]) {
  test(`resume ${change} refuses before fresh output or processes`, async (t) => {
    const f = await interruptedPrefix(t);
    if (change === "candidate")
      await writeFile(join(f.outputDirectory, "recording-1.source.json"), "{}");
    if (change === "source") await writeFile(f.sourcePath, "{}");
    if (change === "runtime")
      f.dependencies.verifyRuntime = async () => ({
        artifacts: [{ key: "asr.model", sha256: "a".repeat(64) }],
        runtime: { bin: f.root, models: f.root },
      });
    if (["report", "nonprefix", "partial-proof"].includes(change)) {
      const report = JSON.parse(await readFile(join(f.outputDirectory, "recovery.json")));
      if (change === "report") report.failureCode = "RECOVERY_FAILED";
      if (change === "nonprefix") report.candidates[0].id = "recording-2";
      if (change === "partial-proof") report.candidates[0].files.pop();
      await writeFile(join(f.outputDirectory, "recovery.json"), JSON.stringify(report));
      if (change !== "report")
        f.resume.previousReportSha256 = digest(
          await readFile(join(f.outputDirectory, "recovery.json")),
        );
    }
    const result = await recoverTranscriptSources(f.resume, f.dependencies);
    assert.notEqual(result.status, "passed");
    await assert.rejects(access(f.resume.outputDirectory));
    assert.equal(
      f.calls.some((call) => call.options),
      false,
    );
  });
}

test("copied candidate tamper and late runtime changes prevent completed resume", async (t) => {
  for (const change of ["copy", "runtime"]) {
    const f = await interruptedPrefix(t);
    const original = f.dependencies.runProcess;
    let verification = 0;
    const verify = f.dependencies.verifyRuntime;
    f.dependencies.verifyRuntime = async (...args) => {
      const runtime = await verify(...args);
      if (change === "runtime" && ++verification === 3)
        runtime.artifacts[0].sha256 = "b".repeat(64);
      return runtime;
    };
    f.dependencies.runProcess = async (...args) => {
      if (change === "copy")
        await writeFile(join(f.resume.outputDirectory, "recording-1.source.json"), "{}");
      return original(...args);
    };
    assert.equal((await recoverTranscriptSources(f.resume, f.dependencies)).status, "failed");
    const report = JSON.parse(await readFile(join(f.resume.outputDirectory, "recovery.json")));
    assert.equal(report.failureCode, "RECOVERY_RESUME_CHANGED");
    assert.equal(
      (
        await recoverTranscriptSources(
          { ...f.options, mode: "publish", outputDirectory: f.resume.outputDirectory },
          f.dependencies,
        )
      ).status,
      "failed",
    );
  }
});

test("explicit empty recognition is retained review and next recording runs without acoustic claims", async (t) => {
  const f = await recoveryFixture(t);
  await f.addRecording();
  const original = f.dependencies.runProcess;
  let count = 0;
  f.dependencies.runProcess = async (...args) => {
    const result = await original(...args);
    if (args[2].label === "Whisper transcription" && ++count === 1)
      await writeFile(
        args[1][args[1].indexOf("-of") + 1] + ".json",
        JSON.stringify({ transcription: [] }),
      );
    return result;
  };
  const result = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(count, 2);
  assert.equal(result.evidence.review, 1);
  assert.equal(result.evidence.eligible, 1);
  const source = JSON.parse(await readFile(join(f.outputDirectory, "recording-1.source.json")));
  assert.deepEqual(source, { sourceKind: "generated", language: "en", segments: [] });
  const assessment = JSON.parse(
    await readFile(join(f.outputDirectory, "recording-1.assessment.json")),
  );
  assert.equal(assessment.actualWords, 0);
  assert.deepEqual(assessment.flags, ["empty", "empty-recognized-segments"]);
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.acousticVerification, "unrun");
  assert.equal((await readdir(f.outputDirectory)).includes("recording-1.paragraphs.md"), false);
  const publish = await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(publish.status, "blocked");
  assert.equal(publish.evidence.publishedCandidates, 1);
  assert.equal(publish.evidence.review, 1);
});

for (const release of ["delayed", "failed", "missing"]) {
  test(`empty recognition requires positive ${release} release settlement`, async (t) => {
    const f = await recoveryFixture(t);
    f.native.segments = [];
    let settle, entered;
    const enteredRelease = new Promise((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise((resolve) => {
      settle = resolve;
    });
    f.dependencies.createModels = (context) => {
      const models = createProductionLocalModels(context);
      models.transcriber.release =
        release === "missing"
          ? undefined
          : async () => {
              entered();
              if (release === "failed")
                throw Object.assign(new Error("fixture release failure"), {
                  code: "MEDIA_PROCESS_CLEANUP",
                  globalSafety: true,
                });
              await releaseGate;
            };
      return models;
    };
    const running = recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
    if (release === "delayed") {
      await enteredRelease;
      await assert.rejects(access(join(f.outputDirectory, "recording-1.source.json")));
      await assert.rejects(access(join(f.outputDirectory, "recovery.json")));
      settle();
    }
    const result = await running;
    if (release === "delayed") assert.equal(result.evidence.review, 1);
    else {
      assert.equal(
        result.checks.some(
          (check) =>
            check.code ===
            (release === "failed" ? "MEDIA_PROCESS_CLEANUP" : "RECOVERY_RELEASE_UNCONFIRMED"),
        ),
        true,
      );
      await assert.rejects(access(join(f.outputDirectory, "recording-1.source.json")));
    }
  });
}

test("retained review prefix remains blocked after resume and never becomes publication authority", async (t) => {
  const f = await interruptedPrefix(t, { review: true });
  f.native.segments[0].text = "Let x equal minus two.";
  const result = await recoverTranscriptSources(f.resume, f.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(result.evidence.review, 1);
  assert.equal(result.evidence.eligible, 1);
  assert.equal(
    result.checks.find((check) => check.id === "recording-1")?.code,
    "RECOVERY_CANDIDATE_REVIEW",
  );
  const publication = await recoverTranscriptSources(
    { ...f.options, mode: "publish", outputDirectory: f.resume.outputDirectory },
    f.dependencies,
  );
  assert.equal(publication.status, "blocked");
  assert.equal(publication.evidence.publishedCandidates, 1);
});

for (const variant of ["sha-array", "directory-array", "inside-previous", "contains-previous"]) {
  test(`resume ${variant} refuses explicit arguments before output or process work`, async (t) => {
    const f = await interruptedPrefix(t);
    if (variant === "sha-array") f.resume.previousReportSha256 = [f.resume.previousReportSha256];
    if (variant === "directory-array") f.resume.previousOutputDirectory = [f.outputDirectory];
    if (variant === "inside-previous")
      f.resume.outputDirectory = join(f.outputDirectory, "nested-resume");
    if (variant === "contains-previous") f.resume.outputDirectory = f.config.media.mediaRoot;
    const result = await recoverTranscriptSources(f.resume, f.dependencies);
    assert.equal(
      result.checks.some(
        (check) =>
          check.code ===
          (variant.endsWith("array") ? "RECOVERY_ARGUMENTS" : "RECOVERY_RESUME_INVALID"),
      ),
      true,
    );
    assert.equal(
      f.calls.some((call) => call.options),
      false,
    );
    if (variant !== "contains-previous") await assert.rejects(access(f.resume.outputDirectory));
  });
}
