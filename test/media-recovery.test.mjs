import assert from "node:assert/strict";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { VAD_MODEL, vadRuntimePin } from "../src/media/vad-model.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { recoveryFixture, digest } from "./fixtures/media-recovery.mjs";

test("plan writes nothing; serial run retains native policy evidence; publication repeats without replacing originals", async (t) => {
  const f = await recoveryFixture(t);
  const queueBefore = await readFile(f.queuePath);
  const before = await readdir(f.config.media.mediaRoot);
  const plan = await recoverTranscriptSources(
    { ...f.options, outputDirectory: undefined, mode: "plan" },
    f.dependencies,
  );
  assert.equal(plan.status, "passed");
  assert.deepEqual(await readdir(f.config.media.mediaRoot), before);
  assert.equal(f.calls.length, 0);
  const run = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(run.status, "passed");
  assert.equal(run.evidence.eligible, 1);
  const call = f.calls.find((call) => call.options?.label === "Whisper transcription");
  assert.equal(call.args[call.args.indexOf("--max-context") + 1], "0");
  assert.equal(call.args.includes("--vad"), false);
  assert.equal(call.args.includes("--no-fallback"), false);
  assert.equal((await lstat(join(f.outputDirectory, "recovery.json"))).mode & 0o777, 0o600);
  const publication = await recoverTranscriptSources(
    { ...f.options, mode: "publish" },
    f.dependencies,
  );
  assert.equal(publication.status, "passed");
  assert.equal(publication.evidence.written, 5);
  const repeat = await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(repeat.status, "passed");
  assert.equal(repeat.evidence.written, 0);
  assert.equal(repeat.evidence.existing, 5);
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
  assert.deepEqual(await readFile(f.queuePath), queueBefore);
});
test("suspicious fresh source remains readable/private; publication refuses it", async (t) => {
  const f = await recoveryFixture(t);
  f.native.segments[0].text = "loop ".repeat(100).trim();
  const run = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(run.status, "blocked");
  assert.equal(run.evidence.review, 1);
  assert.equal(
    (await readFile(join(f.outputDirectory, "recording-1.paragraphs.md"), "utf8")).trim(),
    f.native.segments[0].text,
  );
  const publish = await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(publish.status, "blocked");
  assert.equal(publish.evidence.publishedCandidates, 0);
  assert.equal(publish.evidence.review, 1);
  assert.deepEqual(await readdir(f.course.destination), ["lecture.mp4", "lecture.transcript.md"]);
});
test("malformed native segments retained despite normalizer filtering; no publication", async (t) => {
  const f = await recoveryFixture(t);
  f.native.segments.push({ start: 25, end: 22, text: "Dropped words." });
  const run = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(run.status, "blocked");
  const native = JSON.parse(await readFile(join(f.outputDirectory, "recording-1.native-asr.json")));
  assert.equal(native.segments.length, 2);
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "blocked",
  );
});
test("candidate edits and interrupted partial publication preserve files; unchanged retry is idempotent", async (t) => {
  const f = await recoveryFixture(t);
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
  assert.equal(partial.evidence.partialPublication, "retained-exclusive-files");
  assert.match(partial.evidence.retry, /same unchanged private manifest/);
  const repeat = await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(repeat.status, "passed");
  assert.equal(repeat.evidence.existing, 1);
  await writeFile(join(f.outputDirectory, "recording-1.paragraphs.md"), "user candidate edit");
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});
test("global cleanup failure persists admission barrier and refuses later recovery", async (t) => {
  const f = await recoveryFixture(t);
  const deps = {
    ...f.dependencies,
    runProcess: async () => {
      throw Object.assign(new Error("private failed cleanup"), {
        code: "MEDIA_PROCESS_CLEANUP",
        globalSafety: true,
      });
    },
  };
  const failed = await recoverTranscriptSources({ ...f.options, mode: "run" }, deps);
  assert.equal(failed.status, "blocked");
  assert.equal(
    JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
    "MEDIA_PROCESS_CLEANUP",
  );
  const blocked = await recoverTranscriptSources(
    { ...f.options, outputDirectory: undefined, mode: "plan" },
    f.dependencies,
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks[0].code, "MEDIA_SAFETY_BARRIER");
});
test("interrupt settles owned process before release and retains private failure evidence", async (t) => {
  const f = await recoveryFixture(t);
  const controller = new globalThis.AbortController();
  let settled = false;
  const deps = {
    ...f.dependencies,
    runProcess: async (_command, _args, options) => {
      controller.abort(
        Object.assign(new Error("fixture interruption"), { code: "RECOVERY_INTERRUPTED" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled = true;
      options.signal.throwIfAborted();
    },
  };
  const result = await recoverTranscriptSources(
    { ...f.options, mode: "run", signal: controller.signal },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(settled, true);
  assert.equal(
    JSON.parse(await readFile(join(f.outputDirectory, "recovery.json"))).failureCode,
    "RECOVERY_INTERRUPTED",
  );
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("multiple selected lectures share one lock and never overlap ASR process work", async (t) => {
  const f = await recoveryFixture(t);
  await f.addRecording();
  let active = 0,
    peak = 0,
    acquisitions = 0;
  const runProcess = f.dependencies.runProcess;
  const dependencies = {
    ...f.dependencies,
    lock: async ({ run }) => {
      acquisitions++;
      return run();
    },
    runProcess: async (command, args, options) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await runProcess(command, args, options);
      } finally {
        active--;
      }
    },
  };
  const result = await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.candidates, 2);
  assert.equal(peak, 1);
  assert.equal(acquisitions, 1);
  assert.equal(active, 0);
});

test("late Owner abort after report retention cannot return passed", async (t) => {
  const f = await recoveryFixture(t);
  const controller = new globalThis.AbortController();
  const result = await recoverTranscriptSources(
    { ...f.options, mode: "run", signal: controller.signal },
    {
      ...f.dependencies,
      afterReportRetained: async () =>
        controller.abort(
          Object.assign(new Error("late Owner interruption"), { code: "RECOVERY_INTERRUPTED" }),
        ),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.checks.at(-1).code, "RECOVERY_INTERRUPTED");
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("late monitor capacity failure settles before success and overrides completed candidate checks", async (t) => {
  const f = await recoveryFixture(t);
  f.manifest.budgets.processTimeoutMs = 2000;
  await f.saveManifest();
  let nativeActive = false,
    pendingObserved = false;
  const originalProcess = f.dependencies.runProcess;
  const dependencies = {
    ...f.dependencies,
    createCapacity: async () => ({
      check: async () => {
        if (nativeActive) {
          pendingObserved = true;
          await new Promise((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  Object.assign(new Error("late capacity refusal"), {
                    code: "MEDIA_GLOBAL_SAFETY",
                    globalSafety: true,
                  }),
                ),
              700,
            ),
          );
        }
      },
    }),
    runProcess: async (command, args, options) => {
      if (options.label === "Whisper transcription") {
        nativeActive = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        nativeActive = false;
      }
      return originalProcess(command, args, options);
    },
  };
  const result = await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies);
  assert.equal(pendingObserved, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.at(-1).code, "MEDIA_GLOBAL_SAFETY");
  assert.equal(
    JSON.parse(await readFile(join(f.outputDirectory, "recovery.json"))).failureCode,
    "MEDIA_GLOBAL_SAFETY",
  );
});

test("mixed batch publishes valid subset and records review without promoting looping source", async (t) => {
  const f = await recoveryFixture(t);
  await f.addRecording();
  let attempts = 0;
  const runProcess = f.dependencies.runProcess;
  const dependencies = {
    ...f.dependencies,
    runProcess: async (command, args, options) => {
      if (options.label === "Whisper transcription" && ++attempts === 2)
        f.native.segments[0].text = "loop ".repeat(50).trim();
      return runProcess(command, args, options);
    },
  };
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies)).status,
    "blocked",
  );
  const result = await recoverTranscriptSources({ ...f.options, mode: "publish" }, dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(result.evidence.publishedCandidates, 1);
  assert.equal(result.evidence.review, 1);
  const names = await readdir(f.course.destination);
  assert.equal(
    names.filter((name) => name.includes(".recovered-") && name.endsWith(".md")).length,
    1,
  );
  const run = JSON.parse(await readFile(join(f.outputDirectory, "recovery.json")));
  const index = await readFile(
    join(f.course.destination, "Transcript editions", `asr-recovery-v1-${run.runId}`, "index.md"),
    "utf8",
  );
  assert.match(index, /Lecture one: uncertain mathematics/);
  assert.match(index, /Lecture two: examples.*unpublished \/ review/);
  assert.match(index, /ntulearn\.ntu\.edu\.sg\/ultra\/courses\/.*\/outline/);
  for (const label of [
    "Original source",
    "Retained media",
    "Current media status",
    "Provenance and limitations",
  ])
    assert.ok(index.includes(label));
  assert.equal(index.includes("ks="), false);
});

test("nonspeech policy is selected at generation and retained through plan/report/provenance without replacing failed candidates", async (t) => {
  const f = await recoveryFixture(t),
    queueBefore = await readFile(f.queuePath);
  f.native.segments[0].text = "[BLANK_AUDIO] ".repeat(12).trim();
  const failed = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(failed.status, "blocked");
  const failedNativePath = join(f.outputDirectory, "recording-1.native-asr.json"),
    failedBefore = await readFile(failedNativePath);
  f.manifest.policy = "independent-context-nonspeech-v1";
  await f.saveManifest();
  const outputDirectory = join(f.config.media.mediaRoot, "fresh-nonspeech-candidate"),
    options = { ...f.options, outputDirectory };
  const runProcess = f.dependencies.runProcess;
  const dependencies = {
    ...f.dependencies,
    runProcess: async (command, args, processOptions) => {
      if (processOptions.label === "Whisper transcription" && args.includes("--suppress-nst")) {
        f.calls.push({ command, args, options: processOptions });
        await writeFile(
          args[args.indexOf("-of") + 1] + ".json",
          JSON.stringify({
            language: "en",
            segments: [{ start: 0, end: 20, text: "Let x equal minus two." }],
          }),
        );
        return { stdout: "", stderr: "" };
      }
      return runProcess(command, args, processOptions);
    },
  };
  const plan = await recoverTranscriptSources(
    { ...options, outputDirectory: undefined, mode: "plan" },
    dependencies,
  );
  assert.equal(plan.status, "passed");
  assert.equal(plan.evidence.policy, f.manifest.policy);
  const run = await recoverTranscriptSources({ ...options, mode: "run" }, dependencies);
  assert.equal(run.status, "passed");
  const calls = f.calls.filter((call) => call.options?.label === "Whisper transcription");
  assert.equal(calls[0].args.includes("--suppress-nst"), false);
  assert.equal(calls[1].args.includes("--suppress-nst"), true);
  for (const flag of ["--vad", "--offset-t", "--duration", "--suppress-regex"])
    assert.equal(calls[1].args.includes(flag), false);
  const retainedPlan = JSON.parse(await readFile(join(outputDirectory, "plan.json"))),
    report = JSON.parse(await readFile(join(outputDirectory, "recovery.json")));
  assert.equal(retainedPlan.policy, f.manifest.policy);
  assert.equal(report.manifest.policy, f.manifest.policy);
  assert.equal(
    (await recoverTranscriptSources({ ...options, mode: "publish" }, dependencies)).status,
    "passed",
  );
  const provenanceName = (await readdir(f.course.destination)).find((name) =>
    name.endsWith(".provenance.json"),
  );
  assert.equal(
    JSON.parse(await readFile(join(f.course.destination, provenanceName))).policy,
    f.manifest.policy,
  );
  assert.deepEqual(await readFile(failedNativePath), failedBefore);
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
  assert.deepEqual(await readFile(f.queuePath), queueBefore);
});

for (const text of ["[NON SPEECH]", "I."])
  test(`selected nonspeech generation still retains and refuses zero-duration native ${text.startsWith("[") ? "annotation" : "lexical"} row`, async (t) => {
    const f = await recoveryFixture(t);
    f.manifest.policy = "independent-context-nonspeech-v1";
    await f.saveManifest();
    f.native.segments.push({ start: 20, end: 20, text });
    const run = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
    assert.equal(run.status, "blocked");
    const call = f.calls.find((call) => call.options?.label === "Whisper transcription");
    assert.equal(call.args.includes("--suppress-nst"), true);
    const native = JSON.parse(
        await readFile(join(f.outputDirectory, "recording-1.native-asr.json")),
      ),
      source = JSON.parse(await readFile(join(f.outputDirectory, "recording-1.source.json"))),
      assessed = JSON.parse(await readFile(join(f.outputDirectory, "recording-1.assessment.json")));
    assert.deepEqual(native, f.native);
    assert.equal(source.segments.length, 1);
    assert.equal(assessed.sourceStructure, "failed");
    assert.equal(assessed.timing, "failed");
    assert.equal(assessed.eligible, false);
    assert.equal(
      (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
      "blocked",
    );
    assert.deepEqual(await readdir(f.course.destination), ["lecture.mp4", "lecture.transcript.md"]);
  });

test("unknown recovery policy refuses before runtime or output creation", async (t) => {
  const f = await recoveryFixture(t);
  f.manifest.policy = "independent-context-nonspeech-v2";
  await f.saveManifest();
  const result = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.notEqual(result.status, "passed");
  assert.equal(f.calls.length, 0);
  await assert.rejects(lstat(f.outputDirectory), { code: "ENOENT" });
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("VAD admission refuses absent preparation before output or ASR", async (t) => {
  const f = await recoveryFixture(t);
  f.manifest.policy = "independent-context-nonspeech-vad-v1";
  await f.saveManifest();
  const result = await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(
    f.calls.some((call) => call.options?.label === "Whisper transcription"),
    false,
  );
  await assert.rejects(lstat(f.outputDirectory), { code: "ENOENT" });
});

test("prepared VAD uses full input and retains asset provenance; edited pins refuse publication", async (t) => {
  const f = await recoveryFixture(t);
  f.manifest.policy = "independent-context-nonspeech-vad-v1";
  await f.saveManifest();
  const dependencies = {
    ...f.dependencies,
    verifyVad: async () => ({
      path: join(f.root, "fixture-vad.bin"),
      pin: vadRuntimePin(),
      inputs: [],
    }),
  };
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies)).status,
    "passed",
  );
  const asr = f.calls.find((call) => call.options?.label === "Whisper transcription");
  assert.ok(asr.args.includes("--vad"));
  assert.ok(asr.args.includes("--suppress-nst"));
  assert.equal(asr.args[asr.args.indexOf("--processors") + 1], "1");
  for (const flag of ["--offset-t", "--duration", "--suppress-regex"])
    assert.equal(asr.args.includes(flag), false);
  const extraction = f.calls.find((call) => call.options?.label === "ASR audio extraction");
  assert.equal(
    extraction.args[extraction.args.indexOf("-i") + 1],
    f.manifest.recordings[0].media.path,
  );
  for (const flag of ["-ss", "-t", "-to", "-af"])
    assert.equal(extraction.args.includes(flag), false);
  const reportPath = join(f.outputDirectory, "recovery.json");
  const report = JSON.parse(await readFile(reportPath));
  assert.deepEqual(report.runtimePins.at(-1), vadRuntimePin());
  report.runtimePins.at(-1).sha256 = "0".repeat(64);
  await writeFile(reportPath, JSON.stringify(report));
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, dependencies)).status,
    "blocked",
  );
  assert.deepEqual(await readdir(f.course.destination), ["lecture.mp4", "lecture.transcript.md"]);
  report.runtimePins.at(-1).sha256 = VAD_MODEL.sha256;
  await writeFile(reportPath, JSON.stringify(report));
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, dependencies)).status,
    "passed",
  );
  const provenance = (await readdir(f.course.destination)).find((name) =>
    name.endsWith(".provenance.json"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.course.destination, provenance))).runtimePins.at(-1),
    report.runtimePins.at(-1),
  );
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
});

for (const segments of [
  [],
  [{ start: 0, end: 20, text: "[BLANK_AUDIO] ".repeat(12).trim() }],
  [{ start: 0, end: 1, text: "Let x equal minus two." }],
  [
    { start: 0, end: 20, text: "Let x equal minus two." },
    { start: 20, end: 20, text: "I." },
  ],
])
  test(`VAD preserves native rows and full-duration refusal (${segments.length} rows, end ${segments[0]?.end ?? 0})`, async (t) => {
    const f = await recoveryFixture(t);
    f.manifest.policy = "independent-context-nonspeech-vad-v1";
    await f.saveManifest();
    f.native.segments = segments;
    const dependencies = {
      ...f.dependencies,
      verifyVad: async () => ({
        path: join(f.root, "fixture-vad.bin"),
        pin: vadRuntimePin(),
        inputs: [],
      }),
    };
    assert.notEqual(
      (await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies)).status,
      "passed",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(f.outputDirectory, "recording-1.native-asr.json"))),
      f.native,
    );
    assert.notEqual(
      (await recoverTranscriptSources({ ...f.options, mode: "publish" }, dependencies)).status,
      "passed",
    );
    assert.deepEqual(await readdir(f.course.destination), ["lecture.mp4", "lecture.transcript.md"]);
  });

test("changed prepared asset between extraction and ASR stops before recognition and preserves originals", async (t) => {
  const f = await recoveryFixture(t);
  f.manifest.policy = "independent-context-nonspeech-vad-v1";
  await f.saveManifest();
  const path = join(f.root, "fixture-vad.bin");
  await writeFile(path, "fixture VAD");
  const input = { path, sha256: digest("fixture VAD"), bytes: 11 };
  const dependencies = {
    ...f.dependencies,
    verifyVad: async () => ({ path, pin: vadRuntimePin(), inputs: [input] }),
    runProcess: async (...args) => {
      const result = await f.dependencies.runProcess(...args);
      if (args[2].label === "ASR audio extraction") await writeFile(path, "changed VAD");
      return result;
    },
  };
  assert.notEqual(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, dependencies)).status,
    "passed",
  );
  assert.equal(
    f.calls.some((call) => call.options?.label === "Whisper transcription"),
    false,
  );
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.sourceBody);
});
