import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile, symlink, mkdir, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import {
  historicalReads,
  historicalDigest,
  publishHistoricalFile,
} from "../src/media/historical-files.mjs";

test("exclusive hard-link publication reuses identical bytes and preserves conflicts", async (t) => {
  const at = await historicalFixture(t),
    reads = historicalReads(),
    path = join(at.root, "edition.md"),
    content = Buffer.from("Candidate words");
  const options = { reads, boundary: at.root, expectedSha256: historicalDigest(content) };
  assert.equal(await publishHistoricalFile(path, content, options), "written");
  assert.equal(await publishHistoricalFile(path, content, options), "existing");
  await writeFile(path, "User edit");
  await assert.rejects(publishHistoricalFile(path, content, options));
  assert.equal(await readFile(path, "utf8"), "User edit");
});
test("bounded regular reads reject oversized and linked inputs", async (t) => {
  const at = await historicalFixture(t),
    path = join(at.root, "too-large"),
    alias = join(at.root, "linked");
  await writeFile(path, "12345");
  await symlink(path, alias);
  const reads = historicalReads({ limits: { fileBytes: 4, totalBytes: 10, timeoutMs: 1000 } });
  await assert.rejects(reads.read(path));
  await assert.rejects(historicalReads().read(alias));
});

test("publication refuses an observed parent swap before staging and never writes outside", async (t) => {
  const at = await historicalFixture(t);
  const parent = join(at.root, "editions"),
    outside = join(at.root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  const reads = historicalReads(),
    originalProbe = reads.probe;
  let swapped = false;
  reads.probe = async (operation) => {
    const result = await originalProbe(operation);
    if (result === parent && !swapped) {
      await rename(parent, join(at.root, "retained-parent"));
      await symlink(outside, parent);
      swapped = true;
    }
    return result;
  };
  const content = Buffer.from("Protected source words");
  await assert.rejects(
    publishHistoricalFile(join(parent, "edition.md"), content, {
      reads,
      boundary: at.root,
      expectedSha256: historicalDigest(content),
    }),
  );
  assert.equal(swapped, true);
  assert.deepEqual(await readdir(outside), []);
});

test("publication retains its staged bytes when the parent changes after opening", async (t) => {
  const at = await historicalFixture(t);
  const parent = join(at.root, "editions"),
    outside = join(at.root, "outside"),
    retained = join(at.root, "retained-parent");
  await mkdir(parent);
  await mkdir(outside);
  const reads = historicalReads(),
    originalProbe = reads.probe;
  let swapped = false;
  reads.probe = async (operation) => {
    const result = await originalProbe(operation);
    if (result?.isFile?.() && !swapped) {
      await rename(parent, retained);
      await symlink(outside, parent);
      swapped = true;
    }
    return result;
  };
  const content = Buffer.from("Protected source words");
  await assert.rejects(
    publishHistoricalFile(join(parent, "edition.md"), content, {
      reads,
      boundary: at.root,
      expectedSha256: historicalDigest(content),
    }),
  );
  assert.equal(swapped, true);
  assert.deepEqual(await readdir(outside), []);
  const partials = await readdir(retained);
  assert.equal(partials.length, 1);
  assert.match(partials[0], /^edition\.md\.part-/);
  assert.equal(await readFile(join(retained, partials[0]), "utf8"), content.toString());
});
