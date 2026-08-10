import test from "node:test";
import assert from "node:assert/strict";
import { orderedName, safeResolve, safeSegment } from "../src/paths.mjs";

test("sanitizes filesystem names", () => {
  assert.equal(safeSegment('../A/B:*?"<>|'), "_A_B_______");
  assert.equal(orderedName(0, "Lecture  1"), "01 Lecture 1");
});

test("keeps resolved paths below the destination", () => {
  assert.equal(safeResolve("/tmp/module", "../escape"), "/tmp/module/_escape");
});
