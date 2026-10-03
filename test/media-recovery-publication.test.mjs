import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { recoveryFixture } from "./fixtures/media-recovery.mjs";

test("occupied edited lecture edition refuses repeat publication without overwriting user text", async (t) => {
  const f = await recoveryFixture(t);
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies)).status,
    "passed",
  );
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const name = (await readdir(f.course.destination)).find(
    (name) => name.includes(".recovered-") && name.endsWith(".md"),
  );
  const path = join(f.course.destination, name);
  await writeFile(path, "student edition edit");
  assert.equal(
    (await recoverTranscriptSources({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(path, "utf8"), "student edition edit");
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("original edits during reserve checks are refused before first publication", async (t) => {
  const f = await recoveryFixture(t);
  await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  const deps = {
    ...f.dependencies,
    createCapacity: async () => ({
      check: async () => writeFile(f.originalPath, "concurrent student edit"),
    }),
  };
  const result = await recoverTranscriptSources({ ...f.options, mode: "publish" }, deps);
  assert.equal(result.status, "failed");
  assert.equal(await readFile(f.originalPath, "utf8"), "concurrent student edit");
  assert.deepEqual(await readdir(f.course.destination), ["lecture.mp4", "lecture.transcript.md"]);
});
