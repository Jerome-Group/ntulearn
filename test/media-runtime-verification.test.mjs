import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createRuntimeVerification } from "../src/media/runtime-verification.mjs";

test("bounds stalled reads and consumes late failures without advancing tools", async () => {
  let rejectRead;
  let commands = 0;
  const guard = createRuntimeVerification(
    {},
    {
      verificationTimeoutMs: 20,
      commandRunner: async () => {
        commands += 1;
        return { code: 0 };
      },
    },
  );
  await assert.rejects(
    guard.read(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }),
    ),
    {
      code: "MEDIA_RUNTIME_TIMEOUT",
      globalSafety: true,
    },
  );
  rejectRead(new Error("late fixture failure"));
  await setTimeout(5);
  await assert.rejects(guard.commandRunner("must-not-run", []), { code: "MEDIA_RUNTIME_TIMEOUT" });
  assert.equal(commands, 0);
  const fresh = createRuntimeVerification({}, { verificationTimeoutMs: 1000 });
  assert.equal(await fresh.read(async () => "recovered"), "recovered");
});

test("checks cumulative budget before and after reads and tools", async () => {
  let now = 0;
  const guard = createRuntimeVerification(
    {},
    {
      clock: () => now,
      verificationTimeoutMs: 100,
      commandRunner: async (_command, _args, options) => {
        assert.equal(options.timeoutMs, 50);
        now = 101;
        return { code: 0 };
      },
    },
  );
  await guard.read(async () => {
    now = 50;
  });
  await assert.rejects(guard.commandRunner("fixture", []), { code: "MEDIA_RUNTIME_TIMEOUT" });
  const cleanup = new Error("unconfirmed group cleanup");
  cleanup.globalSafety = true;
  const uncertain = createRuntimeVerification(
    {},
    {
      commandRunner: async () => {
        throw cleanup;
      },
    },
  );
  await assert.rejects(uncertain.commandRunner("fixture", []), (error) => error === cleanup);
});
