import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { catalogueReads, catalogueJson, scanCatalogue } from "../src/media/catalogue-files.mjs";
import { safeNativeTranscriptBody } from "../src/media/native-transcript-safety.mjs";

const metadata = (value) => ({ content: Buffer.from(JSON.stringify(value)) });

test("aggregate metadata scans every link without applying one transcript's address bound to all records", () => {
  const plan = {
    records: Array.from({ length: 18000 }, (_, index) => ({
      path: `/fixture/course/lecture-${index}/transcript.md`,
      source: `https://example.edu/course/lecture-${index}`,
    })),
  };
  assert.throws(() => safeNativeTranscriptBody(plan));
  assert.deepEqual(catalogueJson(metadata(plan)), plan);
  for (const unsafe of [
    "https://example.edu/?%73ig=private",
    "https://example.edu/?a=1&amp;session=private",
    "https://example.edu/%6b%73/private",
  ]) {
    assert.throws(() => catalogueJson(metadata({ ...plan, last: unsafe })), {
      code: "CATALOGUE_METADATA_UNSAFE",
    });
    assert.throws(() => catalogueJson(metadata({ [unsafe]: "key must also be checked" })), {
      code: "CATALOGUE_METADATA_UNSAFE",
    });
  }
});

test("catalogue metadata keeps byte, value, depth, string and encoding bounds", () => {
  for (const value of ["x".repeat(4 * 1024 ** 2 + 1), Array(100001).fill(0)])
    assert.throws(() => catalogueJson(metadata(value)), { code: "CATALOGUE_METADATA_LIMIT" });
  let deep = "leaf";
  for (let index = 0; index < 17; index++) deep = { nested: deep };
  assert.throws(() => catalogueJson(metadata(deep)), { code: "CATALOGUE_METADATA_LIMIT" });
  assert.throws(() => catalogueJson({ content: Buffer.from([0x22, 0xff, 0x22]) }), {
    code: "CATALOGUE_METADATA_INVALID",
  });
  assert.throws(() => catalogueJson({ content: Buffer.from('{"n":1e999}') }), {
    code: "CATALOGUE_METADATA_INVALID",
  });
});

test("overwritten JSON values and escaped keys remain inspected before duplicate keys disappear", () => {
  for (const address of [
    "https://example.edu/?%73ig=private",
    "https://example.edu/%6b%73/private",
  ])
    for (const body of [
      `{"x":${JSON.stringify(address)},"x":"safe"}`,
      `{"nested":{"x":${JSON.stringify(address)},"x":"safe"},"nested":{}}`,
      `{"\\u0078":${JSON.stringify(address)},"x":"safe"}`,
    ])
      assert.throws(() => catalogueJson({ content: Buffer.from(body) }), {
        code: "CATALOGUE_METADATA_UNSAFE",
      });
  assert.throws(() => catalogueJson({ content: Buffer.from('{"n":1e999,"n":0}') }), {
    code: "CATALOGUE_METADATA_INVALID",
  });
  for (const body of [
    '{"nested":' + "[".repeat(17) + "0" + "]".repeat(17) + ',"nested":0}',
    '{"many":[' + Array(100000).fill("null").join(",") + '],"many":0}',
  ])
    assert.throws(() => catalogueJson({ content: Buffer.from(body) }), {
      code: "CATALOGUE_METADATA_LIMIT",
    });
  assert.deepEqual(catalogueJson(metadata({ title: "[Untitled]", literal: "{uncertain}" })), {
    title: "[Untitled]",
    literal: "{uncertain}",
  });
});
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
