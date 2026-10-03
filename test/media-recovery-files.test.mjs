import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoveryFile } from "../src/media/recovery-files.mjs";

test("bounded no-follow recovery reads return exact bytes and reject oversized/symlink evidence", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-recovery-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.json");
  await writeFile(path, "uncertainty 或者");
  const file = await recoveryFile(path);
  assert.equal(file.content.toString("utf8"), "uncertainty 或者");
  await assert.rejects(recoveryFile(path, { maximumBytes: 2 }));
  const alias = join(root, "alias.json");
  await symlink(path, alias);
  await assert.rejects(recoveryFile(alias));
  assert.equal((await recoveryFile(path, { retain: false })).content, undefined);
});
