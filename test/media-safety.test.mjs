import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertMediaSafetyAdmission,
  mediaSafetyPath,
  persistMediaSafetyBarrier,
} from "../src/media/safety.mjs";

test("retains a private write-once cleanup barrier and refuses malformed existing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-safety-"));
  const statePath = join(root, "state.json");
  const error = Object.assign(new Error("Synthetic cleanup"), { code: "MEDIA_PROCESS_CLEANUP" });
  await persistMediaSafetyBarrier({ statePath, error });
  const original = await readFile(mediaSafetyPath(statePath));
  assert.equal((await stat(mediaSafetyPath(statePath))).mode & 0o777, 0o600);
  await persistMediaSafetyBarrier({
    statePath,
    error: Object.assign(new Error(), { code: "MEDIA_BROWSER_CLEANUP" }),
  });
  assert.deepEqual(await readFile(mediaSafetyPath(statePath)), original);
  await assert.rejects(
    assertMediaSafetyAdmission({
      statePath,
      courses: [],
      readQueue: async () => assert.fail("no queue read"),
    }),
    { code: "MEDIA_SAFETY_BARRIER" },
  );
  await writeFile(mediaSafetyPath(statePath), "malformed Owner evidence");
  await assert.rejects(
    assertMediaSafetyAdmission({ statePath, courses: [], readQueue: async () => null }),
    { code: "MEDIA_SAFETY_BARRIER" },
  );
  assert.equal(await readFile(mediaSafetyPath(statePath), "utf8"), "malformed Owner evidence");
});

test("unreadable safety evidence and retained queue marker refuse admission", async () => {
  await assert.rejects(
    assertMediaSafetyAdmission({
      statePath: "/synthetic/state.json",
      courses: [],
      readQueue: async () => null,
      inspect: async () => {
        throw Object.assign(new Error("Fixture permission refusal"), { code: "EACCES" });
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER" },
  );
  await assert.rejects(
    assertMediaSafetyAdmission({
      statePath: "/synthetic/state.json",
      courses: [{ key: "SYNTHETIC", mediaMode: "off" }],
      inspect: async () => {
        throw Object.assign(new Error("Fixture absent latch"), { code: "ENOENT" });
      },
      readQueue: async () => ({
        record: { queue: [{ safetyFailure: "MEDIA_PROCESS_CLEANUP", complete: true }] },
      }),
    }),
    { code: "MEDIA_SAFETY_BARRIER" },
  );
});

test("a barrier write failure refuses normal retry with an actionable containment error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-safety-write-"));
  const occupiedParent = join(root, "occupied");
  await writeFile(occupiedParent, "retained Owner bytes");
  await assert.rejects(
    persistMediaSafetyBarrier({
      statePath: join(occupiedParent, "state.json"),
      error: Object.assign(new Error("Fixture cleanup"), { code: "MEDIA_PROCESS_CLEANUP" }),
    }),
    (error) =>
      error.code === "MEDIA_SAFETY_BARRIER_WRITE" &&
      error.globalSafety &&
      /Retain external containment/.test(error.message),
  );
  assert.equal(await readFile(occupiedParent, "utf8"), "retained Owner bytes");
});
