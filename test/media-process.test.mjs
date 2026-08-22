import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { runMediaProcess } from "../src/media/process.mjs";

test("propagates a queue checkpoint into a running provider subprocess", async () => {
  const controller = new globalThis.AbortController();
  const checkpoint = new Error("04:00 checkpoint");
  checkpoint.code = "MEDIA_CHECKPOINT";
  const running = runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    timeoutMs: 10_000,
    label: "fixture provider",
  });
  await setTimeout(25);
  controller.abort(checkpoint);

  await assert.rejects(running, (error) => error === checkpoint);
});

test("does not start a provider subprocess after its checkpoint signal already fired", async () => {
  const controller = new globalThis.AbortController();
  const checkpoint = new Error("04:00 checkpoint");
  checkpoint.code = "MEDIA_CHECKPOINT";
  controller.abort(checkpoint);

  await assert.rejects(
    runMediaProcess("command-that-must-not-start", [], {
      signal: controller.signal,
      timeoutMs: 10_000,
      label: "fixture provider",
    }),
    (error) => error === checkpoint,
  );
});
