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

test("optional media identities are hash-coupled and descriptor-bound; mutation/replacement/link refuse", async (t) => {
  const { assertRecoveryFileIdentity } = await import("../src/media/recovery-files.mjs"),
    { rename } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-media-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ["mutated", "replaced", "link"]) {
    const path = join(root, kind);
    await writeFile(path, "same source bytes");
    const file = await recoveryFile(path, { retain: false, includeIdentity: true });
    assert.ok(file.identity);
    assert.equal((await recoveryFile(path)).identity, undefined);
    await assertRecoveryFileIdentity(file);
    if (kind === "mutated") await writeFile(path, "changed source bytes");
    else {
      await rename(path, path + ".retained");
      if (kind === "link") await symlink(path + ".retained", path);
      else await writeFile(path, "same source bytes");
    }
    await assert.rejects(assertRecoveryFileIdentity(file));
  }
});
