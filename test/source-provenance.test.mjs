import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSourceEdition, provenanceRecords } from "../src/sync/source-provenance.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const identity = hash("synthetic-owned");
const expected = {
  source: { identity, kind: "announcement", version: hash("UPSTREAM"), originalPath: "Notice.md" },
  content: "UPSTREAM",
};
async function fixture(fn) {
  const destination = await mkdtemp(join(tmpdir(), "source-provenance-"));
  try {
    await fn(destination);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
test("provenance records only accepted current bytes and immutable retries reuse", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const before = await readdir(directory);
    await recordSourceEdition(destination, expected, path);
    assert.deepEqual(await readdir(directory), before);
    const records = await provenanceRecords(destination, expected.source);
    assert.equal(records[0].sha256, hash("UPSTREAM"));
    assert.equal(records[0].bytes, 8);
    await writeFile(path, "USEREDIT");
    await assert.rejects(recordSourceEdition(destination, expected, path), /Source changed.*Retry/);
    assert.equal(await readFile(path, "utf8"), "USEREDIT");
    assert.deepEqual(await readdir(directory), before);
  }));
test("edited provenance and symlinked provenance parents refuse without touching originals", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const [name] = await readdir(directory);
    await writeFile(join(directory, name), "{}");
    await assert.rejects(provenanceRecords(destination, expected.source), /provenance.*Restore/);
    assert.equal(await readFile(path, "utf8"), "UPSTREAM");
    await rm(directory, { recursive: true });
    await symlink(destination, directory);
    await assert.rejects(provenanceRecords(destination, expected.source), /symlink.*run/);
  }));
test("malformed, oversized and excessive provenance remain bounded failures", () =>
  fixture(async (destination) => {
    const directory = join(destination, "Source editions", identity);
    await mkdir(directory, { recursive: true });
    const path = join(directory, hash("file") + ".json");
    await writeFile(path, "x".repeat(65537));
    await assert.rejects(provenanceRecords(destination, expected.source), /malformed.*Restore/);
    await rm(path);
    await Promise.all(
      Array.from({ length: 129 }, (_, i) =>
        writeFile(join(directory, hash(String(i)) + ".json"), "{}"),
      ),
    );
    await assert.rejects(provenanceRecords(destination, expected.source), /too large.*Inspect/);
  }));
