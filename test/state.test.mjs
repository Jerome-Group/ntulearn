import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { courseState, newIds, readState, writeState } from "../src/sync/state.mjs";

function statePath() {
  return mkdtemp(join(tmpdir(), "ntulearn-state-")).then((root) => join(root, "state.json"));
}

test("reads an absent state file as an empty state", async () => {
  assert.deepEqual(await readState(await statePath()), { version: 1, courses: {} });
});

test("round-trips the state", async () => {
  const path = await statePath();
  await writeState(path, { version: 1, courses: { AB1234: { contentIds: ["_1_1"] } } });
  assert.deepEqual((await readState(path)).courses.AB1234.contentIds, ["_1_1"]);
});

test("fills in a missing version and courses map", async () => {
  const path = await statePath();
  await writeState(path, { courses: { AB1234: {} } });
  const state = await readState(path);
  assert.equal(state.version, 1);
  assert.deepEqual(Object.keys(state.courses), ["AB1234"]);
});

test("reports a course never synced as empty rather than undefined", () => {
  const empty = courseState({ courses: {} }, "AB1234");
  assert.deepEqual(empty.contentIds, []);
  assert.deepEqual(empty.downloads, {});
  assert.deepEqual(empty.announcementIds, []);
  assert.deepEqual(empty.conversationIds, []);
});

test("returns the recorded state for a course that has one", () => {
  const recorded = { contentIds: ["_1_1"], downloads: {} };
  assert.equal(courseState({ courses: { AB1234: recorded } }, "AB1234"), recorded);
});

test("reports the ids that were not there last time", () => {
  assert.deepEqual(newIds(["a", "b", "c"], ["a"]), ["b", "c"]);
  assert.deepEqual(newIds(["a"], ["a", "b"]), []);
  assert.deepEqual(newIds(["a"]), ["a"]);
});
