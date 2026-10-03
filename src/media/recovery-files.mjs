import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withEvaluationRead } from "./evaluation-read.mjs";

export function recoveryFailure(code = "RECOVERY_EVIDENCE_INVALID") {
  return Object.assign(
    new Error(
      "Inspect private recovery evidence and retry with unchanged inputs and a fresh candidate directory; all originals remain.",
    ),
    { code },
  );
}

export function recoveryFile(path, { maximumBytes = 4 * 1024 ** 2, signal, retain = true } = {}) {
  return withEvaluationRead(
    async (readSignal) => {
      if ((await realpath(path)) !== path) throw recoveryFailure();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximumBytes) throw recoveryFailure();
        const hash = createHash("sha256"),
          parts = [];
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          readSignal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > before.size || bytes > maximumBytes) throw recoveryFailure();
          const part = buffer.subarray(0, bytesRead);
          hash.update(part);
          if (retain) parts.push(Buffer.from(part));
        }
        const after = await handle.stat(),
          current = await lstat(path);
        if (
          bytes !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          current.mtimeMs !== before.mtimeMs
        )
          throw recoveryFailure("RECOVERY_INPUT_CHANGED");
        return {
          path,
          sha256: hash.digest("hex"),
          bytes,
          ...(retain ? { content: Buffer.concat(parts) } : {}),
        };
      } finally {
        await handle.close();
      }
    },
    { signal },
  );
}

export async function recoveryDirectoryBytes(path, maximumBytes, signal) {
  let bytes = 0,
    entries = 0;
  async function walk(directory, depth) {
    signal?.throwIfAborted();
    if (depth > 8) throw recoveryFailure("RECOVERY_OUTPUT_BUDGET");
    for (const name of await readdir(directory)) {
      if (++entries > 20000) throw recoveryFailure("RECOVERY_OUTPUT_BUDGET");
      const child = join(directory, name),
        info = await lstat(child);
      if (info.isSymbolicLink()) throw recoveryFailure();
      if (info.isDirectory()) await walk(child, depth + 1);
      else if (info.isFile()) bytes += info.size;
      else throw recoveryFailure();
      if (bytes > maximumBytes) throw recoveryFailure("RECOVERY_OUTPUT_BUDGET");
    }
  }
  await withEvaluationRead(() => walk(path, 0), { signal });
  return bytes;
}
