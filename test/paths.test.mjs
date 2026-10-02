import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDestinationPath } from "../src/sync/paths.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { orderedName, safeResolve, safeSegment } from "../src/sync/paths.mjs";

test("sanitizes filesystem names", () => {
  assert.equal(safeSegment('../A/B:*?"<>|'), "_A_B_______");
  assert.equal(safeSegment("  spaced   out  "), "spaced out");
  assert.equal(safeSegment(""), "untitled");
  assert.equal(safeSegment(null), "untitled");
});

test("numbers a name from its zero-based position", () => {
  assert.equal(orderedName(0, "Lecture  1"), "01 Lecture 1");
  assert.equal(orderedName(11, "Lecture 12"), "12 Lecture 12");
  assert.equal(orderedName(undefined, "Unpositioned"), "01 Unpositioned");
});

test("keeps resolved paths below the destination", () => {
  assert.equal(safeResolve("/tmp/course", "../escape"), "/tmp/course/_escape");
  assert.equal(safeResolve("/tmp/course", "Week 1", "Notes.md"), "/tmp/course/Week 1/Notes.md");
});

test("permits a configured symlink root but refuses exact and nested linked descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-path-boundary-"));
  const real = join(root, "real");
  const configured = join(root, "configured");
  const outside = join(root, "outside");
  await mkdir(real);
  await mkdir(outside);
  await symlink(real, configured);
  await assertDestinationPath(configured, join(configured, "new", "file.txt"));
  await symlink(outside, join(real, "linked"));
  await assert.rejects(
    assertDestinationPath(configured, join(configured, "linked", "file.txt")),
    /symlink/,
  );
  await assert.rejects(assertDestinationPath(configured, join(configured, "linked")), /symlink/);
  await assert.rejects(assertDestinationPath(configured, join(outside, "file.txt")), /Unsafe/);
});
