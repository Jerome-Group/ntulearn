import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isFilePresent,
  moveDirectory,
  relinkFile,
  writeAtomically,
  writeIfChanged,
} from "../src/sync/files.mjs";

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
  assert.equal(await isFilePresent(path, 5), true);
  assert.equal(await isFilePresent(path, 6), false);
  assert.equal(await isFilePresent(path, null), true);
  assert.equal(await isFilePresent(join(root, "missing.bin"), 5), false);
  assert.equal(await isFilePresent(root, null), false);
});

// `rename` replaces whatever is at the new name silently, which is a delete in the one operation
// this repository is most careful about (ADR-0003). Renumbering takes the new name by `link`, so a
// name already in use refuses the move instead of consuming what is there (ADR-0010).
test("refuses to give a file a name that is already in use, and keeps both", async () => {
  const at = await workspace();
  await writeFile(join(at, "01 Notes.pdf"), "mine");
  await writeFile(join(at, "02 Notes.pdf"), "somebody else's");

  const took = await relinkFile(join(at, "01 Notes.pdf"), join(at, "02 Notes.pdf"));

  assert.equal(took, false);
  assert.equal(await readFile(join(at, "01 Notes.pdf"), "utf8"), "mine");
  assert.equal(await readFile(join(at, "02 Notes.pdf"), "utf8"), "somebody else's");
});

test("gives a file a free name and leaves nothing at the old one", async () => {
  const at = await workspace();
  await writeFile(join(at, "01 Notes.pdf"), "mine");

  const took = await relinkFile(join(at, "01 Notes.pdf"), join(at, "02 Notes.pdf"));

  assert.equal(took, true);
  assert.deepEqual(await readdir(at), ["02 Notes.pdf"]);
  assert.equal(await readFile(join(at, "02 Notes.pdf"), "utf8"), "mine");
});

// A directory has no `link` to claim a name with, so the name is looked at first.
test("refuses to move a directory onto a name that holds anything", async () => {
  const at = await workspace();
  await mkdir(join(at, "01 Week 1"));
  await writeFile(join(at, "01 Week 1", "01 Slides.pdf"), "slides");
  await mkdir(join(at, "02 Week 1"));

  const took = await moveDirectory(join(at, "01 Week 1"), join(at, "02 Week 1"));

  assert.equal(took, false);
  assert.deepEqual(await readdir(join(at, "01 Week 1")), ["01 Slides.pdf"]);
  assert.deepEqual(await readdir(join(at, "02 Week 1")), []);
});
