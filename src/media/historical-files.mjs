import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, readdir, mkdir, link, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { withEvaluationRead } from "./evaluation-read.mjs";

export const HISTORICAL_LIMITS = Object.freeze({
  files: 20000,
  depth: 16,
  fileBytes: 4 * 1024 ** 2,
  totalBytes: 256 * 1024 ** 2,
  outputBytes: 256 * 1024 ** 2,
  timeoutMs: 120000,
});
export const historicalDigest = (value) => createHash("sha256").update(value).digest("hex");
export const historicalFailure = (code) =>
  Object.assign(
    new Error(
      "Historical formatting evidence changed or exceeds its bounds. Inspect the private plan and retained files, then retry plan; originals are retained.",
    ),
    code ? { code } : {},
  );
export const insideHistoricalRoot = (root, path) => path.startsWith(root + sep);

export function historicalReads({ signal, limits = HISTORICAL_LIMITS } = {}) {
  let entries = 0,
    bytes = 0,
    files = 0;
  const deadline = Date.now() + limits.timeoutMs;
  function active() {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw historicalFailure("HISTORICAL_READ_LIMIT");
  }
  const probe = (operation) => {
    active();
    return withEvaluationRead(operation, {
      signal,
      timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
    });
  };
  return {
    active,
    probe,
    evidence: () => ({ readBytes: bytes, readFiles: files, maximumReadBytes: limits.totalBytes }),
    async read(path, { includeIdentity = false } = {}) {
      return probe(async () => {
        if ((await realpath(path)) !== path) throw historicalFailure();
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat();
          if (!before.isFile()) throw historicalFailure();
          if (before.size > limits.fileBytes || bytes + before.size > limits.totalBytes)
            throw historicalFailure("HISTORICAL_READ_LIMIT");
          const parts = [];
          let received = 0;
          const buffer = Buffer.alloc(Math.min(limits.fileBytes + 1, 64 * 1024));
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            received += bytesRead;
            if (received > before.size || received > limits.fileBytes) throw historicalFailure();
            parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
          }
          const content = Buffer.concat(parts);
          const after = await handle.stat(),
            current = await lstat(path);
          if (
            content.length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            current.mtimeMs !== before.mtimeMs ||
            (includeIdentity &&
              (after.ctimeMs !== before.ctimeMs || current.ctimeMs !== before.ctimeMs))
          )
            throw historicalFailure();
          bytes += content.length;
          files++;
          return {
            path,
            sha256: historicalDigest(content),
            bytes: content.length,
            content,
            ...(includeIdentity
              ? {
                  identity: {
                    dev: before.dev,
                    ino: before.ino,
                    size: before.size,
                    mtimeMs: before.mtimeMs,
                    ctimeMs: before.ctimeMs,
                  },
                }
              : {}),
          };
        } finally {
          await handle.close();
        }
      });
    },
    async scan(root) {
      const paths = [];
      const walk = async (directory, depth) => {
        if (depth > limits.depth) throw historicalFailure();
        for (const name of (await probe(() => readdir(directory))).sort()) {
          active();
          if (++entries > limits.files) throw historicalFailure();
          if (name === ".runtime") continue;
          const path = join(directory, name),
            info = await probe(() => lstat(path));
          if (info.isSymbolicLink()) throw historicalFailure();
          if (info.isDirectory()) await walk(path, depth + 1);
          else if (
            info.isFile() &&
            (/(?:transcript\.(?:raw|metadata|state)\.json|\.transcript\.md)$/i.test(name) ||
              directory.split(sep).includes("provider"))
          )
            paths.push(path);
        }
      };
      await walk(root, 0);
      return paths;
    },
  };
}

export async function publishHistoricalFile(
  path,
  content,
  { reads, boundary, checkCapacity, expectedSha256 },
) {
  reads.active();
  if (!insideHistoricalRoot(boundary, resolve(path))) throw historicalFailure();
  let ancestor = dirname(path);
  while (ancestor !== boundary) {
    const info = await reads
      .probe(() => lstat(ancestor))
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw historicalFailure();
    ancestor = dirname(ancestor);
  }
  await reads.probe(() => checkCapacity?.({ path, boundary, bytes: content.length }));
  await reads.probe(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }));
  const parent = dirname(path);
  const parentInfo = await reads.probe(() => lstat(parent));
  async function assertParent() {
    const info = await reads.probe(() => lstat(parent));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== parentInfo.dev ||
      info.ino !== parentInfo.ino ||
      (await reads.probe(() => realpath(parent))) !== parent
    )
      throw historicalFailure();
    const current = await reads.probe(() => lstat(parent));
    if (
      current.dev !== parentInfo.dev ||
      current.ino !== parentInfo.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink()
    )
      throw historicalFailure();
  }
  await assertParent();
  const partial = path + ".part-" + randomUUID();
  const handle = await open(partial, "wx", 0o600);
  const owned = await handle.stat();
  async function assertOwned(candidate) {
    await assertParent();
    const info = await reads.probe(() => lstat(candidate));
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== owned.dev || info.ino !== owned.ino)
      throw historicalFailure();
  }
  try {
    await assertOwned(partial);
    await handle.writeFile(content);
    await handle.sync();
    await assertOwned(partial);
    reads.active();
    try {
      await link(partial, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await assertParent();
      const existing = await reads.read(path);
      await assertParent();
      if (existing.sha256 !== expectedSha256) throw historicalFailure();
      return "existing";
    }
    await assertOwned(path);
    return "written";
  } finally {
    await handle.close().catch(() => {});
    // Uncertain directory or staging identity retains evidence; never unlink a replacement.
    await assertOwned(partial);
    await unlink(partial);
  }
}
