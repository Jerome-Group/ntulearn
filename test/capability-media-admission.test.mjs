import assert from "node:assert/strict";
import test from "node:test";
import { mediaAdmissionObservation } from "../src/capabilities/media-admission.mjs";

const absent = () => {
  throw Object.assign(new Error("synthetic absence"), { code: "ENOENT" });
};
test("admission health/status metadata identifies retained evidence without values or process claims", async () => {
  const result = await mediaAdmissionObservation("/synthetic-private/state.json", async (path) => {
    if (path.endsWith("media-lock-admission.json")) return { isFile: () => true };
    return absent();
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.evidence, { markersPresent: 1 });
  assert.ok(!JSON.stringify(result).includes("synthetic-private"));
  assert.match(result.message, /active or retained/);
});
test("absent admission metadata preserves ordinary observations and uncertainty fails closed", async () => {
  assert.equal((await mediaAdmissionObservation("/synthetic/state.json", absent)).status, "passed");
  const result = await mediaAdmissionObservation("/synthetic/state.json", async () => {
    throw new Error("private filesystem cause");
  });
  assert.equal(result.status, "failed");
  assert.ok(!JSON.stringify(result).includes("private filesystem cause"));
});
