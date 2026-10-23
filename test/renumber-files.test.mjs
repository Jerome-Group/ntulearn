import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("a public source replaced after publication keeps the student's new inode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-renumber-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sync"));
  await writeFile(
    join(root, "atomic.mjs"),
    await readFile(new URL("../src/atomic.mjs", import.meta.url)),
  );
  const source = await readFile(new URL("../src/sync/files.mjs", import.meta.url), "utf8");
  await writeFile(
    join(root, "sync", "files.mjs"),
    source.replace('from "node:fs/promises"', 'from "../fs.mjs"'),
  );
  const from = join(root, "01 Notes.md"),
    to = join(root, "02 Notes.md");
  await writeFile(from, "sync bytes A");
  await writeFile(
    join(root, "fs.mjs"),
    `
    export * from "node:fs/promises";
    import * as fs from "node:fs/promises";
    export async function link(source, target) {
      await fs.link(source, target);
      await fs.writeFile(${JSON.stringify(from + ".editor")}, "student edit B");
      await fs.rename(${JSON.stringify(from + ".editor")}, ${JSON.stringify(from)});
    }
  `,
  );
  const { relinkFile } = await import(pathToFileURL(join(root, "sync", "files.mjs")));
  assert.equal(await relinkFile(from, to), true);
  assert.equal(await readFile(to, "utf8"), "sync bytes A");
  const studentEdit = await readFile(from, "utf8").catch((error) => error.code);
  assert.equal(studentEdit, "student edit B");
});
