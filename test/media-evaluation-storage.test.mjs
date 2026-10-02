import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluationOutputRoot } from "../src/media/evaluation-storage.mjs";

test("explicit evaluation roots require canonical containment and the configured device", async (t) => {
  const volumeRoot = await mkdtemp(join(tmpdir(), "ntulearn-evaluation-root-"));
  t.after(() => rm(volumeRoot, { recursive: true, force: true }));
  const mediaRoot = join(volumeRoot, "media");
  const scratch = join(volumeRoot, "scratch");
  await mkdir(mediaRoot);
  await mkdir(scratch);
  assert.equal(await evaluationOutputRoot({ mediaRoot }, undefined, { volumeRoot }), mediaRoot);
  assert.equal(await evaluationOutputRoot({ mediaRoot }, scratch, { volumeRoot }), scratch);
  await symlink(scratch, join(volumeRoot, "alias"));
  await assert.rejects(
    evaluationOutputRoot({ mediaRoot }, join(volumeRoot, "alias"), { volumeRoot }),
  );
  await assert.rejects(evaluationOutputRoot({ mediaRoot }, tmpdir(), { volumeRoot }));
});
