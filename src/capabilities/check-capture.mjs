import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const CHECK_CAPTURE_BYTES = 2 * 1024 * 1024;

export function createCheckCapture() {
  const streams = Object.fromEntries(
    ["stdout", "stderr"].map((name) => [
      name,
      { parts: [], bytes: 0, retainedBytes: 0, digest: createHash("sha256") },
    ]),
  );
  return {
    append(name, value) {
      const stream = streams[name],
        chunk = Buffer.from(value);
      stream.bytes += chunk.length;
      stream.digest.update(chunk);
      const prefix = chunk.subarray(0, CHECK_CAPTURE_BYTES - stream.retainedBytes);
      if (prefix.length) stream.parts.push(prefix);
      stream.retainedBytes += prefix.length;
    },
    result() {
      return Object.fromEntries(
        Object.entries(streams).map(([name, stream]) => [
          name,
          {
            bytes: stream.bytes,
            sha256: stream.digest.digest("hex"),
            prefix: Buffer.concat(stream.parts),
            truncated: stream.bytes > stream.retainedBytes,
          },
        ]),
      );
    },
  };
}
