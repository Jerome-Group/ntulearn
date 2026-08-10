import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isFileOfSize, writeAtomically, writeIfChanged } from "../src/sync/files.mjs";

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

test("rewrites only when the content differs", async () => {
  const root = await workspace();
  const path = join(root, "a.md");
  assert.equal(await writeIfChanged(path, "one"), true);
  assert.equal(await writeIfChanged(path, "one"), false);
  assert.equal(await writeIfChanged(path, "two"), true);
  assert.equal(await readFile(path, "utf8"), "two");
});

test("matches an existing file by size, and reports a missing one as no match", async () => {
  const root = await workspace();
  const path = join(root, "a.bin");
  await writeFile(path, "12345");
  assert.equal(await isFileOfSize(path, 5), true);
  assert.equal(await isFileOfSize(path, 6), false);
  assert.equal(await isFileOfSize(path, null), true);
  assert.equal(await isFileOfSize(join(root, "missing.bin"), 5), false);
  assert.equal(await isFileOfSize(root, null), false);
});
