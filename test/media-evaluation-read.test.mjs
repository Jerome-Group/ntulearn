import assert from "node:assert/strict";
import test from "node:test";
import { withEvaluationRead } from "../src/media/evaluation-read.mjs";

test("read deadlines abort owned streams and late read-only completion cannot become a promotion", async () => {
  let signal;
  let finish;
  const probe = withEvaluationRead(
    (owned) => {
      signal = owned;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(probe, ({ code }) => code === "EVALUATION_READ_TIMEOUT");
  assert.equal(signal.aborted, true);
  finish("late readonly result");
});

test("external checkpoint reasons survive read guards and valid bounded reads succeed", async () => {
  const controller = new globalThis.AbortController();
  const reason = new Error("checkpoint");
  const pending = withEvaluationRead(() => new Promise(() => {}), { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(await withEvaluationRead(() => "ready"), "ready");
});
