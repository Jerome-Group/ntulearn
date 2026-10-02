import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateFixture } from "../src/media/evaluation-fixture.mjs";

async function fixture(t, segments, markdown = "Fixture source wording.") {
  const output = await mkdtemp(join(tmpdir(), "ntulearn-evaluation-fixture-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(join(output, "work"));
  const evidence = { fixtures: [], stages: [] };
  const checks = [];
  const options = {
    fixture: {
      id: "fixture-1",
      audio: { path: "fixture.wav", sha256: "a".repeat(64) },
      reference: { kind: "unavailable" },
    },
    manifest: { budgets: { processTimeoutMs: 100, maxFixtureSeconds: 300, maxOutputBytes: 10000 } },
    media: {
      setup: {
        mediaTool: { filename: "ffmpeg" },
        asr: { runtime: { filename: "whisper" }, model: { filename: "asr" } },
        formatter: { runtime: { filename: "llama" }, model: { filename: "formatter" } },
      },
      tools: { ffprobe: "ffprobe" },
    },
    runtime: { runtime: { bin: output, models: output } },
    output,
    checks,
    evidence,
    put: (name, body) =>
      writeFile(join(output, name), typeof body === "string" ? body : JSON.stringify(body), {
        flag: "wx",
      }),
    budgetCheck: async () => {},
    combined: new globalThis.AbortController().signal,
    dependencies: {
      runProcess: async () => ({ stdout: '{"format":{"duration":"20"}}', stderr: "" }),
      createModels: () => ({
        transcriber: {
          transcribe: async () => ({ sourceKind: "generated", language: "en", segments }),
        },
        formatter: { format: async () => ({ markdown }) },
      }),
    },
  };
  return { options, output, evidence, checks };
}

test("fixture source rejection preserves source evidence and leaves formatting unrun", async (t) => {
  const held = await fixture(t, [{ start: 0, end: 40, text: "Fixture source wording." }]);
  await evaluateFixture(held.options);
  assert.equal(held.evidence.fixtures[0].timestamps.status, "failed");
  assert.equal(held.evidence.fixtures[0].formatting, "unrun");
  assert.equal(
    JSON.parse(await readFile(join(held.output, "fixture-1.source-transcript.json"), "utf8"))
      .segments[0].end,
    40,
  );
  await assert.rejects(readFile(join(held.output, "fixture-1.formatted.md")), { code: "ENOENT" });
});

test("fixture rejects invented formatter words before derivative promotion", async (t) => {
  const held = await fixture(
    t,
    [{ start: 0, end: 20, text: "Fixture source wording." }],
    "Fixture invented source wording.",
  );
  await assert.rejects(evaluateFixture(held.options), /preserve|lexical|source|word/i);
  assert.equal(held.evidence.fixtures[0].formatting, "unrun");
  await assert.rejects(readFile(join(held.output, "fixture-1.formatted.md")), { code: "ENOENT" });
});
