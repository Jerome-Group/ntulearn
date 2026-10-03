import assert from "node:assert/strict";
import test from "node:test";
import { monitorMediaCapacity } from "../src/media/capacity-monitor.mjs";

test("serializes capacity probes and drains an in-flight failure on cancellation", async () => {
  let tick;
  let finishProbe;
  let cancelled = false;
  let failure;
  const stop = monitorMediaCapacity(
    () =>
      new Promise((resolve, reject) => {
        finishProbe = reject;
      }),
    {
      onFailure: (error) => {
        failure = error;
      },
      schedule: (callback) => {
        tick = callback;
        return "synthetic-timer";
      },
      cancel: () => {
        cancelled = true;
      },
    },
  );
  tick();
  await Promise.resolve();
  const drained = stop();
  finishProbe(new Error("Scratch reserve exhausted"));
  await drained;
  assert.equal(cancelled, true);
  assert.equal(failure?.globalSafety, true);
  assert.match(failure?.message ?? "", /Scratch reserve/);
});

test("bounds shutdown of an unresolved probe and reports a late rejection only once", async () => {
  let tick;
  let rejectLate;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const failures = [];
  const stop = monitorMediaCapacity(
    () =>
      new Promise((_, reject) => {
        rejectLate = reject;
        entered();
      }),
    {
      timeoutMs: 10,
      onFailure: (error) => failures.push(error),
      schedule: (callback) => {
        tick = callback;
        return "timer";
      },
      cancel: () => {},
    },
  );
  tick();
  await started;
  await Promise.race([
    stop(),
    new Promise((_, reject) =>
      globalThis.setTimeout(() => reject(new Error("fixture exceeded bound")), 150),
    ),
  ]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].globalSafety, true);
  assert.equal(failures[0].code, "MEDIA_FILE_CLEANUP");
  rejectLate(new Error("late underlying filesystem rejection"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(failures.length, 1);
});
