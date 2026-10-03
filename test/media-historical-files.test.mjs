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

test("read limit evidence distinguishes file bytes, aggregate bytes and elapsed time without exposing inputs", async (t) => {
  const f = await historicalFixture(t),
    path = join(f.root, "bounded-read");
  await writeFile(path, "12345");
  for (const [limits, expected] of [
    [
      { fileBytes: 4, totalBytes: 20, timeoutMs: 1000 },
      { kind: "file-bytes", observed: 5, maximum: 4 },
    ],
    [
      { fileBytes: 5, totalBytes: 4, timeoutMs: 1000 },
      { kind: "read-bytes", observed: 5, maximum: 4 },
    ],
  ]) {
    const reads = historicalReads({ limits });
    await assert.rejects(reads.read(path), (error) => {
      assert.equal(error.code, "HISTORICAL_READ_LIMIT");
      assert.deepEqual(error.limit, expected);
      return true;
    });
    assert.equal(reads.evidence().readBytes, 0);
  }
  let time = 500;
  const reads = historicalReads({
    now: () => time,
    limits: { fileBytes: 5, totalBytes: 9, timeoutMs: 1000 },
  });
  await reads.read(path);
  await assert.rejects(reads.read(path), (error) => {
    assert.deepEqual(error.limit, { kind: "read-bytes", observed: 10, maximum: 9 });
    return true;
  });
  time += 1000;
  assert.throws(
    () => reads.active(),
    (error) => {
      assert.equal(error.code, "HISTORICAL_READ_LIMIT");
      assert.deepEqual(error.limit, { kind: "elapsed-ms", observed: 1000, maximum: 1000 });
      return true;
    },
  );
  assert.deepEqual(reads.evidence(), {
    readBytes: 5,
    readFiles: 1,
    maximumReadBytes: 9,
    maximumFileBytes: 5,
    elapsedMs: 1000,
    timeoutMs: 1000,
  });
});

test("beforeStage runs after positive reuse and before any directory or staging mutation", async (t) => {
  const f = await historicalFixture(t),
    parent = join(f.root, "guarded-new-directory"),
    path = join(parent, "edition.md"),
    content = Buffer.from("Source words");
  const calls = [],
    reads = historicalReads();
  const options = {
    reads,
    boundary: f.root,
    expectedSha256: historicalDigest(content),
    existingFile: async () => {
      calls.push("existing");
      return false;
    },
    checkCapacity: async () => {
      calls.push("capacity");
    },
    beforeStage: async () => {
      calls.push("guard");
      throw new Error("fixture source changed");
    },
  };
  await assert.rejects(publishHistoricalFile(path, content, options), /fixture source changed/);
  assert.deepEqual(calls, ["existing", "capacity", "guard"]);
  assert.equal((await readdir(f.root)).includes("guarded-new-directory"), false);
  calls.length = 0;
  assert.equal(
    await publishHistoricalFile(path, content, {
      ...options,
      existingFile: async () => {
        calls.push("existing");
        return true;
      },
    }),
    "existing",
  );
  assert.deepEqual(calls, ["existing"]);
  assert.equal((await readdir(f.root)).includes("guarded-new-directory"), false);
});
