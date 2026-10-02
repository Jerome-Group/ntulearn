import assert from "node:assert/strict";
import test from "node:test";
import { createEvaluationProcess } from "../src/media/evaluation-process.mjs";

test("records supported memory and safe flags without exposing private captured output", async () => {
  const stages = [];
  const run = createEvaluationProcess({
    memoryMeasurement: "darwin-time",
    timeoutMs: 100,
    onStage: (stage) => stages.push(stage),
    runProcess: async (command, args, options) => {
      assert.equal(command, "/usr/bin/time");
      assert.equal(args[0], "-l");
      assert.equal(options.timeoutMs, 100);
      return { stdout: "private words", stderr: "1024 maximum resident set size\nprivate path" };
    },
  });
  await run("private-command", ["-f", "/private/source", "-l", "auto"], {
    timeoutMs: 500,
    label: "Fixture ASR",
  });
  assert.equal(stages[0].maxRssBytes, 1024);
  assert.doesNotMatch(JSON.stringify(stages), /private words|private path|private\/source/);
});

test("unsupported memory remains unrun and process failures retain their reason", async () => {
  const stages = [];
  const reason = new Error("private failure");
  const run = createEvaluationProcess({
    timeoutMs: 100,
    onStage: (stage) => stages.push(stage),
    runProcess: async () => {
      throw reason;
    },
  });
  await assert.rejects(
    run("fixture", [], { timeoutMs: 500, label: "Fixture ASR" }),
    (error) => error === reason,
  );
  assert.equal(stages[0].memoryStatus, "unrun");
  assert.equal(stages[0].maxRssBytes, null);
  assert.doesNotMatch(JSON.stringify(stages), /private failure/);
});

test("ambiguous child and measurement stderr records never become proven RSS", async () => {
  const stages = [];
  const run = createEvaluationProcess({
    memoryMeasurement: "darwin-time",
    timeoutMs: 100,
    onStage: (stage) => stages.push(stage),
    runProcess: async () => ({
      stdout: "",
      stderr: "7 maximum resident set size\n2048 maximum resident set size\n",
    }),
  });
  await run("fixture", [], { label: "Whisper transcription", timeoutMs: 100 });
  assert.equal(stages[0].maxRssBytes, null);
  assert.equal(stages[0].memoryStatus, "unrun");
});
