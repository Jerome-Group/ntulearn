import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionLocalModels } from "../src/media/production-local.mjs";

function context(work, runProcess) {
  const model = {
    name: "fixture",
    revision: "fixture",
    sha256: "a".repeat(64),
    license: "fixture",
  };
  return {
    paths: { work },
    commands: { llama: "fixture", ffmpeg: "fixture", whisper: "fixture" },
    models: { asr: "fixture", formatter: "fixture" },
    runProcess,
    setup: {
      asr: { runtime: { revision: "fixture" }, model },
      formatter: { runtime: { revision: "fixture" }, model },
    },
  };
}

for (const model of ["formatter", "transcriber"]) {
  test(`${model} preserves scratch and propagates uncertain process cleanup`, async () => {
    const work = await mkdtemp(join(tmpdir(), "ntulearn-process-scratch-"));
    try {
      const failure = new Error("Inspect runtime processes before retrying");
      failure.code = "MEDIA_PROCESS_CLEANUP";
      failure.globalSafety = true;
      const local = createProductionLocalModels(
        context(work, async () => {
          throw failure;
        }),
      );
      const input =
        model === "formatter"
          ? { language: "en", segments: [{ start: 0, end: 10, text: "Fixture source wording." }] }
          : { media: { path: "fixture.mp4", kind: "video", audio: true } };
      await assert.rejects(
        local[model][model === "formatter" ? "format" : "transcribe"](input),
        (error) => error === failure,
      );
      assert.equal((await readdir(work)).length, 1);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}

test("formatter output overflow stays actionable and never promotes fallback completion", async () => {
  const work = await mkdtemp(join(tmpdir(), "ntulearn-process-overflow-"));
  try {
    const failure = new Error("Output limit exceeded. Check configured bound before retrying.");
    failure.code = "MEDIA_OUTPUT_LIMIT";
    const local = createProductionLocalModels(
      context(work, async (_command, _args, options) => {
        assert.equal(options.stdoutMaxBytes, 1024 * 1024);
        throw failure;
      }),
    );
    await assert.rejects(
      local.formatter.format({
        language: "en",
        segments: [{ start: 0, end: 10, text: "Fixture source wording." }],
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("evaluation artifact retention is explicit and ordinary model cleanup remains unchanged", async (t) => {
  for (const preserveArtifacts of [false, true]) {
    const work = await mkdtemp(join(tmpdir(), "ntulearn-local-retention-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    const local = createProductionLocalModels({
      ...context(work, async (_command, args, options) => {
        if (options.label === "Whisper transcription")
          await writeFile(
            `${args[args.indexOf("-of") + 1]}.json`,
            JSON.stringify({ segments: [{ start: 0, end: 20, text: "Fixture source wording." }] }),
          );
        return { stdout: "Fixture source wording.", stderr: "" };
      }),
      preserveArtifacts,
    });
    await local.transcriber.transcribe({ media: { path: "fixture.wav", kind: "audio" } });
    await local.formatter.format({
      language: "en",
      segments: [{ start: 0, end: 20, text: "Fixture source wording." }],
    });
    assert.equal((await readdir(work)).length, preserveArtifacts ? 2 : 0);
  }
});
