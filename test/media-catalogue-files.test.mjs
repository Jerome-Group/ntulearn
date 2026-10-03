import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { catalogueReads, scanCatalogue } from "../src/media/catalogue-files.mjs";
test("scanner refuses links and nonregular evidence, skips runtime and managed history, no body output", async (t) => {
  const f = await historicalFixture(t),
    root = f.config.courses[0].destination;
  await mkdir(join(root, ".runtime"));
  await writeFile(join(root, ".runtime", "recovery.json"), "private runtime body");
  assert.equal(
    (await scanCatalogue(root, catalogueReads())).some((path) => path.includes(".runtime")),
    false,
  );
  await symlink(f.originalPath, join(root, "alias.transcript.md"));
  await assert.rejects(scanCatalogue(root, catalogueReads()), { code: "CATALOGUE_PATH_UNSAFE" });
});
test("bounded reader refuses oversize evidence, changed bytes and aborted inspection", async (t) => {
  const f = await historicalFixture(t),
    reads = catalogueReads();
  await reads.file(f.originalPath);
  await writeFile(f.originalPath, "changed");
  await assert.rejects(reads.file(f.originalPath), { code: "CATALOGUE_INPUT_CHANGED" });
  const controller = new globalThis.AbortController();
  controller.abort(new Error("synthetic abort"));
  await assert.rejects(scanCatalogue(f.root, catalogueReads(controller.signal)));
  await writeFile(f.originalPath, "x".repeat(16 * 1024 ** 2 + 1));
  await assert.rejects(catalogueReads().file(f.originalPath));
});
