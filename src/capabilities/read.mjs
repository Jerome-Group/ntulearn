import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";

export async function readEvidence(path, maximumBytes = 1024 * 1024) {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes)
      return { status: "failed", code: "EVIDENCE_SIZE" };
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maximumBytes) return { status: "failed", code: "EVIDENCE_SIZE" };
    return { status: "passed", value: JSON.parse(bytes.subarray(0, length).toString("utf8")) };
  } catch (error) {
    return error.code === "ENOENT"
      ? { status: "blocked", code: "EVIDENCE_MISSING" }
      : { status: "failed", code: "EVIDENCE_UNREADABLE" };
  } finally {
    await handle?.close();
  }
}
