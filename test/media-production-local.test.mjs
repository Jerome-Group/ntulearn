import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
        if (options.label === "Local transcript formatting") {
          const prompt = await readFile(args[args.indexOf("-f") + 1], "utf8");
          await writeFile(
            args[args.indexOf("--output-file") + 1],
            `User:\n${prompt}\n\nAssistant:\nFixture source wording.\n\n`,
          );
        }
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

test("formatter accepts only assistant evidence despite noisy stdout", async () => {
  const work = await mkdtemp(join(tmpdir(), "ntulearn-formatter-record-"));
  try {
    const text = "Fixture source wording.";
    const local = createProductionLocalModels(
      context(work, async (_command, args) => {
        const outputIndex = args.indexOf("--output-file");
        assert.ok(outputIndex >= 0, "formatter must request separate assistant evidence");
        const prompt = await readFile(args[args.indexOf("-f") + 1], "utf8");
        await writeFile(args[outputIndex + 1], `User:\n${prompt}\n\nAssistant:\n${text}\n\n`);
        return { stdout: `Available commands: /exit /clear\n> ${prompt}\nExiting...` };
      }),
    );
    const result = await local.formatter.format({
      language: "en",
      segments: [{ start: 0, end: 10, text }],
    });
    assert.deepEqual(result.limitations, []);
    assert.equal(result.markdown.trim(), text);
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("formatter rejects malformed and changed assistant evidence without accepting clean stdout", async () => {
  const text = "Technical x = 2 source wording.";
  for (const kind of [
    "missing",
    "malformed",
    "empty",
    "oversize",
    "symlink",
    "directory",
    "words",
    "symbols",
    "timestamps",
    "duplicate",
  ]) {
    const work = await mkdtemp(join(tmpdir(), "ntulearn-formatter-reject-"));
    try {
      const local = createProductionLocalModels(
        context(work, async (_command, args) => {
          const output = args[args.indexOf("--output-file") + 1];
          const prompt = await readFile(args[args.indexOf("-f") + 1], "utf8");
          const prefix = `User:\n${prompt}\n\nAssistant:\n`;
          if (kind === "missing") await rm(output);
          else if (kind === "symlink") {
            await rm(output);
            await symlink(args[args.indexOf("-f") + 1], output);
          } else if (kind === "directory") {
            await rm(output);
            await mkdir(output);
          } else
            await writeFile(
              output,
              {
                malformed: `User:\nchanged\n\nAssistant:\n${text}`,
                empty: prefix,
                oversize: "x".repeat(1024 * 1024 + 1),
                words: prefix + "Invented source wording.",
                symbols: prefix + text.replace("= 2", "= -2"),
                timestamps: prefix + "[00:01] " + text,
                duplicate: prefix + text + `\n\nAssistant:\n${text}`,
              }[kind],
            );
          return { stdout: text };
        }),
      );
      const result = await local.formatter.format({
        language: "en",
        segments: [{ start: 0, end: 10, text }],
      });
      assert.equal(result.markdown.trim(), text, kind);
      assert.ok(result.limitations.length, kind);
      assert.deepEqual(await readdir(work), [], kind);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
});

test("formatter keeps record-looking source text and propagates checkpoint cancellation", async () => {
  const work = await mkdtemp(join(tmpdir(), "ntulearn-formatter-source-record-"));
  try {
    const text = "User:\nsource\n\nAssistant:\nsource ending";
    const controller = new globalThis.AbortController();
    const failure = new Error("Retry after checkpoint");
    let cancel = false;
    const local = createProductionLocalModels(
      context(work, async (_command, args) => {
        const prompt = await readFile(args[args.indexOf("-f") + 1], "utf8");
        await writeFile(
          args[args.indexOf("--output-file") + 1],
          `User:\n${prompt}\n\nAssistant:\n${text}\n\n`,
        );
        if (cancel) controller.abort(failure);
        return { stdout: "noisy stdout" };
      }),
    );
    const input = { language: "en", segments: [{ start: 0, end: 10, text }] };
    const result = await local.formatter.format(input);
    assert.deepEqual(result.limitations, []);
    assert.equal(result.markdown.trim(), text);
    cancel = true;
    await assert.rejects(
      local.formatter.format({ ...input, signal: controller.signal }),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("production ASR types only explicit empty native segments", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "ntulearn-empty-asr-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const local = createProductionLocalModels(
    context(work, async (_command, args, options) => {
      if (options.label === "Whisper transcription")
        await writeFile(
          `${args[args.indexOf("-of") + 1]}.json`,
          JSON.stringify({ transcription: [] }),
        );
      return { stdout: "", stderr: "" };
    }),
  );
  await assert.rejects(
    local.transcriber.transcribe({ media: { path: "fixture.wav", kind: "audio" } }),
    {
      code: "MEDIA_ASR_NO_RECOGNIZED_SEGMENTS",
    },
  );
});

for (const native of [
  {},
  { transcription: null },
  { transcription: null, segments: [] },
  { transcription: [], segments: null },
  { transcription: [], segments: {} },
  { transcription: {}, segments: [] },
  { transcription: {} },
  { transcription: [{ start: 0, end: 0, text: "discarded" }] },
  { transcription: [], segments: [{ start: 0, end: 20, text: "conflicting" }] },
  { transcription: [], metadata: "?access_token=fixture-sensitive" },
]) {
  test("missing, malformed, filtered, conflicting or unsafe native output is never typed empty", async (t) => {
    const work = await mkdtemp(join(tmpdir(), "ntulearn-empty-asr-negative-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    const local = createProductionLocalModels(
      context(work, async (_command, args, options) => {
        if (options.label === "Whisper transcription")
          await writeFile(`${args[args.indexOf("-of") + 1]}.json`, JSON.stringify(native));
        return { stdout: "", stderr: "" };
      }),
    );
    await assert.rejects(
      local.transcriber.transcribe({ media: { path: "fixture.wav", kind: "audio" } }),
      (error) => error.code !== "MEDIA_ASR_NO_RECOGNIZED_SEGMENTS",
    );
  });
}
