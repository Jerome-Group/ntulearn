import assert from "node:assert/strict";
import test from "node:test";
import { withCapacityDeadline } from "../src/media/capacity-deadline.mjs";

test("returns responsive capacity evidence and globally rejects an unresolved probe", async () => {
  assert.equal(await withCapacityDeadline(async () => 200, { timeoutMs: 10 }), 200);
  await assert.rejects(
    withCapacityDeadline(() => new Promise(() => {}), { timeoutMs: 10 }),
    (error) => error.code === "MEDIA_CAPACITY_TIMEOUT" && error.globalSafety === true,
  );
  assert.throws(() => withCapacityDeadline(async () => {}, { timeoutMs: 0 }), /positive deadline/);
});
