import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planMediaEvaluation, runMediaEvaluation } from "../src/media/evaluation.mjs";

async function fixture(
  t,
  { invalidTimes = false, unavailable = false, interruption = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-evaluation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const words = "Let x equal minus two.";
  await writeFile(join(root, "source.wav"), "audio");
  await writeFile(join(root, "reference.txt"), words);
  const manifest = {
    version: 1,
    budgets: {
      maxFixtureSeconds: 300,
      maxInputBytes: 1000,
      maxOutputBytes: 100000,
      jobTimeoutMs: 500,
      processTimeoutMs: 250,
    },
    fixtures: [
      {
        audio: { path: "source.wav", sha256: hash("audio") },
        reference: unavailable
          ? { kind: "unavailable" }
          : {
              kind: "generated-script",
              path: "reference.txt",
              sha256: hash(words),
              provenance: {
                method: "speech-synthesis",
                sourceSha256: hash("audio"),
                referenceSha256: hash(words),
              },
            },
      },
    ],
    ...(interruption ? { interruptionAfterMs: 5 } : {}),
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  const media = {
    mediaRoot,
    setup: {
      mediaTool: { filename: "ffmpeg" },
      asr: { runtime: { filename: "whisper" }, model: { filename: "asr" } },
      formatter: { runtime: { filename: "llama" }, model: { filename: "formatter" } },
    },
    tools: { ffprobe: "ffprobe" },
  };
  const calls = [];
  const deps = {
    volumeRoot: root,
    verifyRuntime: async () => {
      calls.push("runtime");
      return {
        artifacts: [{ key: "model", sha256: hash("model") }],
        runtime: { bin: root, models: root },
      };
    },
    createCapacity: async () => ({ check: async () => calls.push("capacity") }),
    runProcess: async () => ({ stdout: '{"format":{"duration":"20"}}', stderr: "" }),
    createModels: (context) => ({
      transcriber: {
        transcribe: async ({ signal }) => {
          if (interruption && !calls.includes("interrupted")) {
            calls.push("interrupted");
            await context.runProcess(
              "whisper",
              ["-of", join(mediaRoot, "fresh-output", "work", "native")],
              {
                signal,
                label: "Whisper transcription",
                timeoutMs: 250,
              },
            );
          }
          return {
            sourceKind: "generated",
            language: "en",
            segments: [{ start: 0, end: invalidTimes ? 40 : 20, text: words }],
          };
        },
      },
      formatter: {
        format: async () => {
          calls.push("format");
          return { markdown: words, limitations: [] };
        },
      },
    }),
  };
  if (interruption)
    deps.runProcess = async (_command, _args, options) =>
      options.label === "Audio duration probe"
        ? { stdout: '{"format":{"duration":"20"}}' }
        : new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            }),
          );
  return {
    root,
    manifestPath,
    media,
    deps,
    calls,
    outputDirectory: join(mediaRoot, "fresh-output"),
  };
}

test("plan is read-only and run preserves immutable sources with separate truthful evidence", async (t) => {
  const held = await fixture(t);
  const plan = await planMediaEvaluation(held);
  assert.equal(plan.status, "passed");
  assert.equal(plan.evidence.execution, "unrun");
  assert.deepEqual(held.calls, []);
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "blocked");
  assert.equal(report.exitCode, 2);
  assert.equal(report.evidence.fixtures[0].alignment.conditionalWer, 0);
  assert.equal(report.evidence.fixtures[0].speechFidelity, "unrun");
  assert.equal(report.evidence.fixtures[0].formatting, "passed");
  assert.equal(await readFile(join(held.root, "source.wav"), "utf8"), "audio");
  assert.equal(JSON.stringify(report).includes(held.root), false);
  assert.equal(JSON.stringify(report).includes("Let x"), false);
  assert.equal(held.calls[0], "runtime");
  assert.equal(
    JSON.parse(await readFile(join(held.outputDirectory, "evaluation.json"), "utf8")).schemaVersion,
    1,
  );
  const repeated = await runMediaEvaluation(held, held.deps);
  assert.equal(repeated.status, "failed");
  assert.equal(
    await readFile(join(held.outputDirectory, "fixture-1.formatted.md"), "utf8"),
    "Let x equal minus two.",
  );
});

test("invalid timestamp output is retained, remains red and formatting is unrun", async (t) => {
  const held = await fixture(t, { invalidTimes: true, unavailable: true });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(
    report.checks.find(({ id }) => id.endsWith(":timestamps")).code,
    "EVALUATION_TIMESTAMPS_REJECTED",
  );
  assert.equal(report.evidence.fixtures[0].formatting, "unrun");
  assert.equal(report.evidence.fixtures[0].alignment, null);
  assert.equal(held.calls.includes("format"), false);
  assert.equal(
    JSON.parse(
      await readFile(join(held.outputDirectory, "fixture-1.source-transcript.json"), "utf8"),
    ).segments[0].end,
    40,
  );
});

test("bounded deliberate checkpoint recovers with fresh signal and preserves source", async (t) => {
  const held = await fixture(t, { interruption: true });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.evidence.fixtures[0].interruption, {
    status: "passed",
    recovery: "passed",
    cleanup: "owned-group-confirmed",
  });
  assert.equal(
    report.evidence.stages.some(({ status }) => status === "failed"),
    true,
  );
});

test("runtime failure and symlink/output collisions fail before model execution without raw private errors", async (t) => {
  const held = await fixture(t);
  held.deps.verifyRuntime = async () => {
    throw new Error(`${held.root} private session`);
  };
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(JSON.stringify(report).includes(held.root), false);
  assert.equal(held.calls.includes("format"), false);
  await mkdir(held.outputDirectory);
  await writeFile(join(held.outputDirectory, "user.md"), "user edits");
  assert.equal(await readFile(join(held.outputDirectory, "user.md"), "utf8"), "user edits");
});

test("native rejected ASR survives cleanup, and output-budget failures recover into a fresh directory", async (t) => {
  const held = await fixture(t, { invalidTimes: true });
  held.deps.runProcess = async (_command, args, options) => {
    if (options.label === "Whisper transcription") {
      await writeFile(`${args[args.indexOf("-of") + 1]}.json`, '{"rejected":"private ASR words"}');
      return { stdout: "", stderr: "" };
    }
    return { stdout: '{"format":{"duration":"20"}}', stderr: "" };
  };
  held.deps.createModels = (context) => ({
    transcriber: {
      transcribe: async ({ signal }) => {
        const native = join(held.outputDirectory, "work", "native");
        await context.runProcess("whisper", ["-of", native], {
          label: "Whisper transcription",
          timeoutMs: 100,
          signal,
        });
        throw new Error("private invalid native response");
      },
    },
    formatter: {},
  });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(
    await readFile(join(held.outputDirectory, "fixture-1.native-asr.json"), "utf8"),
    '{"rejected":"private ASR words"}',
  );
  assert.equal(JSON.stringify(report).includes("private ASR words"), false);
  assert.equal(report.checks.find(({ id }) => id === "inputs").status, "passed");
  assert.equal(
    JSON.parse(await readFile(join(held.outputDirectory, "evaluation.json"), "utf8")).checks.some(
      ({ status }) => status === "failed",
    ),
    true,
  );
});

test("symlinked output boundaries and bounded storage failures leave originals unchanged", async (t) => {
  const held = await fixture(t);
  const real = join(held.root, "real");
  await mkdir(real);
  await symlink(real, join(held.root, "alias"));
  held.outputDirectory = join(held.root, "alias", "output");
  assert.equal((await runMediaEvaluation(held, held.deps)).status, "failed");
  held.outputDirectory = join(held.media.mediaRoot, "new-budget-attempt");
  const manifest = JSON.parse(await readFile(held.manifestPath, "utf8"));
  manifest.budgets.maxOutputBytes = 10;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  const failed = await runMediaEvaluation(held, held.deps);
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.checks.some(({ code }) => code === "EVALUATION_OUTPUT_BUDGET"),
    true,
  );
  assert.equal(await readFile(join(held.root, "source.wav"), "utf8"), "audio");
  manifest.budgets.maxOutputBytes = 100000;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  held.outputDirectory = join(held.media.mediaRoot, "recovery");
  assert.equal((await runMediaEvaluation(held, held.deps)).status, "blocked");
});

test("evaluation detects meaningful native ASR rows lost during normalization", async (t) => {
  const held = await fixture(t);
  held.deps.runProcess = async (_command, args, options) => {
    if (options.label === "Whisper transcription") {
      await writeFile(
        `${args[args.indexOf("-of") + 1]}.json`,
        JSON.stringify({
          transcription: [
            { text: "Let x equal minus two.", offsets: { from: 0, to: 20000 } },
            { text: "Missing source words", offsets: { from: "invalid", to: 22000 } },
          ],
        }),
      );
      return { stdout: "", stderr: "" };
    }
    return { stdout: '{"format":{"duration":"20"}}', stderr: "" };
  };
  held.deps.createModels = (context) => ({
    transcriber: {
      transcribe: async ({ signal }) => {
        await context.runProcess("whisper", ["-of", join(held.outputDirectory, "work", "native")], {
          label: "Whisper transcription",
          timeoutMs: 100,
          signal,
        });
        return {
          sourceKind: "generated",
          language: "en",
          segments: [{ start: 0, end: 20, text: "Let x equal minus two." }],
        };
      },
    },
    formatter: {
      format: async () => {
        throw new Error("formatter must remain unrun");
      },
    },
  });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(report.evidence.fixtures[0].sourceStructure.droppedSegments, 1);
  assert.equal(report.evidence.fixtures[0].formatting, "unrun");
  assert.equal(report.checks.find(({ id }) => id.endsWith(":timestamps")).status, "passed");
});

test("native ASR order is checked before production normalization can sort it", async (t) => {
  const held = await fixture(t);
  held.deps.runProcess = async (_command, args, options) => {
    if (options.label === "Whisper transcription") {
      await writeFile(
        `${args[args.indexOf("-of") + 1]}.json`,
        JSON.stringify({
          segments: [
            { start: 10, end: 20, text: "second phrase" },
            { start: 0, end: 10, text: "first phrase" },
          ],
        }),
      );
      return { stdout: "", stderr: "" };
    }
    return { stdout: '{"format":{"duration":"20"}}', stderr: "" };
  };
  held.deps.createModels = (context) => ({
    transcriber: {
      transcribe: async ({ signal }) => {
        await context.runProcess("whisper", ["-of", join(held.outputDirectory, "work", "native")], {
          label: "Whisper transcription",
          timeoutMs: 100,
          signal,
        });
        return {
          sourceKind: "generated",
          language: "en",
          segments: [
            { start: 0, end: 10, text: "first phrase" },
            { start: 10, end: 20, text: "second phrase" },
          ],
        };
      },
    },
    formatter: { format: async () => ({ markdown: "first phrase second phrase" }) },
  });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(report.evidence.fixtures[0].formatting, "unrun");
  assert.equal(report.evidence.fixtures[0].nativeTimestamps.status, "failed");
});

test("native ASR output survives a nonzero process exit", async (t) => {
  const held = await fixture(t);
  held.deps.runProcess = async (_command, args, options) => {
    if (options.label === "Whisper transcription") {
      await writeFile(`${args[args.indexOf("-of") + 1]}.json`, '{"partial":true}');
      throw new Error("private nonzero exit");
    }
    return { stdout: '{"format":{"duration":"20"}}', stderr: "" };
  };
  held.deps.createModels = (context) => ({
    transcriber: {
      transcribe: ({ signal }) =>
        context.runProcess("whisper", ["-of", join(held.outputDirectory, "work", "native")], {
          label: "Whisper transcription",
          timeoutMs: 100,
          signal,
        }),
    },
    formatter: {},
  });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(
    await readFile(join(held.outputDirectory, "fixture-1.failed.native-asr.json"), "utf8"),
    '{"partial":true}',
  );
});

test("whole-run budget rejects late runtime preflight before output or models", async (t) => {
  const held = await fixture(t);
  const manifest = JSON.parse(await readFile(held.manifestPath, "utf8"));
  manifest.budgets.jobTimeoutMs = 60;
  manifest.budgets.processTimeoutMs = 30;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  let finish;
  held.deps.verifyRuntime = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  assert.equal(held.calls.includes("format"), false);
  finish({ artifacts: [], runtime: {} });
  await assert.rejects(
    readFile(join(held.outputDirectory, "provenance.json")),
    ({ code }) => code === "ENOENT",
  );
  assert.equal(
    report.checks.some(({ code }) =>
      ["EVALUATION_JOB_TIMEOUT", "EVALUATION_READ_TIMEOUT"].includes(code),
    ),
    true,
  );
});

test("caller-authorized scratch roots are explicit and capacity verifies that boundary", async (t) => {
  const held = await fixture(t);
  const scratch = join(held.root, "authorized-scratch");
  await mkdir(scratch);
  held.outputRoot = scratch;
  held.outputDirectory = join(scratch, "fresh-run");
  held.deps.createCapacity = async (_media, { courses }) => {
    assert.deepEqual(courses, [{ destination: scratch }]);
    return { check: async ({ boundary }) => assert.equal(boundary, scratch) };
  };
  assert.equal((await runMediaEvaluation(held, held.deps)).status, "blocked");
  delete held.outputRoot;
  held.outputDirectory = join(scratch, "default-refusal");
  assert.equal((await runMediaEvaluation(held, held.deps)).status, "failed");
});

test("runtime read deadline drains owned process cleanup and preserves global uncertainty", async (t) => {
  const held = await fixture(t);
  const manifest = JSON.parse(await readFile(held.manifestPath, "utf8"));
  manifest.budgets.jobTimeoutMs = 30;
  manifest.budgets.processTimeoutMs = 20;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  held.signalProcessGroup = () => true;
  let finished = false;
  held.deps.verifyRuntime = async (_media, options) => {
    try {
      await options.commandRunner(process.execPath, ["-e", "setTimeout(()=>{},150)"]);
    } finally {
      finished = true;
    }
    return { artifacts: [], runtime: {} };
  };
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(finished, true);
  assert.equal(report.checks.find(({ id }) => id === "execution").code, "MEDIA_PROCESS_CLEANUP");
  assert.equal(held.calls.includes("format"), false);
});

test("stalled readonly output ancestry checks expire without a late write and recover", async (t) => {
  const held = await fixture(t);
  const manifest = JSON.parse(await readFile(held.manifestPath, "utf8"));
  manifest.budgets.jobTimeoutMs = 60;
  manifest.budgets.processTimeoutMs = 30;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  let finish;
  held.deps.assertArtifactPath = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const report = await runMediaEvaluation(held, held.deps);
  assert.equal(report.status, "failed");
  finish();
  await assert.rejects(readFile(join(held.outputDirectory, "provenance.json")), { code: "ENOENT" });
  delete held.deps.assertArtifactPath;
  manifest.budgets.jobTimeoutMs = 1000;
  manifest.budgets.processTimeoutMs = 500;
  await writeFile(held.manifestPath, JSON.stringify(manifest));
  assert.equal((await runMediaEvaluation(held, held.deps)).status, "blocked");
});
