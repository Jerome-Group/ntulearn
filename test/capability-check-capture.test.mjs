import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createCheckCapture, CHECK_CAPTURE_BYTES } from "../src/capabilities/check-capture.mjs";

test("private capture preserves UTF-8 bytes across child chunks and independent stream digests", () => {
  const capture = createCheckCapture();
  capture.append("stdout", Buffer.from([0xe2]));
  capture.append("stdout", Buffer.from([0x82, 0xac]));
  capture.append("stderr", Buffer.from("original assertion"));
  const result = capture.result();
  assert.equal(result.stdout.prefix.toString(), "€");
  assert.equal(result.stdout.bytes, 3);
  assert.equal(result.stderr.prefix.toString(), "original assertion");
  assert.equal(
    result.stderr.sha256,
    createHash("sha256").update("original assertion").digest("hex"),
  );
  assert.equal(result.stdout.truncated, false);
});
test("bounded prefix is distinct from full captured bytes/digest and cannot silently drop truncation", () => {
  const capture = createCheckCapture(),
    output = Buffer.alloc(CHECK_CAPTURE_BYTES + 31, 65);
  capture.append("stdout", output);
  const result = capture.result().stdout;
  assert.equal(result.prefix.length, CHECK_CAPTURE_BYTES);
  assert.equal(result.bytes, output.length);
  assert.equal(result.truncated, true);
  assert.equal(result.sha256, createHash("sha256").update(output).digest("hex"));
  assert.notEqual(result.sha256, createHash("sha256").update(result.prefix).digest("hex"));
});
