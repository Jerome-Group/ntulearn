import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isFilePresent, writeAtomically, writeWithoutReplacing } from "../src/sync/files.mjs";

function workspace() {
  return mkdtemp(join(tmpdir(), "ntulearn-files-"));
}

test("creates the parent folders a write needs", async () => {
  const root = await workspace();
  const path = join(root, "Week 1", "Notes.md");
  await writeAtomically(path, "body");
  assert.equal(await readFile(path, "utf8"), "body");
});

test("leaves no partial file behind", async () => {
  const root = await workspace();
  await writeAtomically(join(root, "a.md"), "body");
  assert.deepEqual(await readdir(root), ["a.md"]);
});

test("claims absent files and refuses different occupied bytes", async () => {
  const root = await workspace();
  const path = join(root, "a.md");
  assert.equal(await writeWithoutReplacing(path, "one"), true);
  assert.equal(await writeWithoutReplacing(path, "one"), false);
  await assert.rejects(writeWithoutReplacing(path, "two"), { code: "SYNC_FILE_CONFLICT" });
  assert.equal(await readFile(path, "utf8"), "one");
});

test("matches an existing file by size, and reports a missing one as no match", async () => {
  const root = await workspace();
  const path = join(root, "a.bin");
  await writeFile(path, "12345");
  assert.equal(await isFilePresent(path, 5), true);
  assert.equal(await isFilePresent(path, 6), false);
  assert.equal(await isFilePresent(path, null), true);
  assert.equal(await isFilePresent(join(root, "missing.bin"), 5), false);
  assert.equal(await isFilePresent(root, null), false);
});

test("racing empty-path claims never replace the winning bytes and clean their own partials", async () => {
  const root = await workspace();
  const path = join(root, "race.bin");
  const outcomes = await Promise.allSettled([
    writeWithoutReplacing(path, "first"),
    writeWithoutReplacing(path, "second"),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled" && result.value === true).length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (result) => result.status === "rejected" && result.reason.code === "SYNC_FILE_CONFLICT",
    ).length,
    1,
  );
  assert.ok(["first", "second"].includes(await readFile(path, "utf8")));
  assert.deepEqual(await readdir(root), ["race.bin"]);
});

test("preserves an occupied directory rather than treating it as an empty filename", async () => {
  const root = await workspace();
  const path = join(root, "Notes.md");
  await mkdir(path);
  await writeFile(join(path, "owned.txt"), "retained");
  await assert.rejects(writeWithoutReplacing(path, "new note"), { code: "SYNC_FILE_CONFLICT" });
  assert.equal(await readFile(join(path, "owned.txt"), "utf8"), "retained");
  assert.deepEqual(await readdir(root), ["Notes.md"]);
});

test("explains blocked exclusive publication and retries after directory repair", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "occupied");
  const path = join(parent, "Notes.md");
  await writeFile(parent, "retained original");
  await assert.rejects(
    writeWithoutReplacing(path, "note"),
    (error) =>
      error.code === "ENOTDIR" &&
      error.cause?.code === "ENOTDIR" &&
      /repair.*directory.*exclusive/i.test(error.message),
  );
  assert.equal(await readFile(parent, "utf8"), "retained original");
  await rm(parent);
  await mkdir(parent);
  assert.equal(await writeWithoutReplacing(path, "note"), true);
  assert.equal(await writeWithoutReplacing(path, "note"), false);
  assert.deepEqual(await readdir(parent), ["Notes.md"]);
});
