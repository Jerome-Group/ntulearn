import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { lstat, open, realpath } from "node:fs/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { historicalFailure as catalogueFailure } from "./historical-files.mjs";
import { markGlobalMediaSafety } from "./errors.mjs";

export const CATALOGUE_MEDIA_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 ** 3,
  totalBytes: 128 * 1024 ** 3,
  hashes: 4096,
  identityChecks: 100000,
  fileTimeoutMs: 30000,
  timeoutMs: 120000,
  cleanupTimeoutMs: 5000,
});
const identity = (info) => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function createCatalogueMediaReads(
  signal,
  { limits = CATALOGUE_MEDIA_LIMITS, inspect = lstat, canonical = realpath, openFile = open } = {},
) {
  for (const [key, maximum] of Object.entries(CATALOGUE_MEDIA_LIMITS))
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > maximum)
      throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
  let bytes = 0,
    hashes = 0,
    identityChecks = 0;
  const deadline = Date.now() + limits.timeoutMs;
  const active = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
  };
  async function parents(path, boundary, combined) {
    const pins = [];
    let parent = dirname(path);
    while (true) {
      combined.throwIfAborted();
      const info = await inspect(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
      pins.push({ path: parent, dev: info.dev, ino: info.ino });
      if (parent === boundary) return pins;
      const next = dirname(parent);
      if (next === parent) throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
      parent = next;
    }
  }
  async function assertParents(pins, combined) {
    for (const pin of pins) {
      combined.throwIfAborted();
      const info = await inspect(pin.path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== pin.dev ||
        info.ino !== pin.ino
      )
        throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
    }
  }
  async function bounded(operation) {
    active();
    const controller = new globalThis.AbortController();
    const combined = signal
      ? globalThis.AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let timer, stopped;
    const aborted = new Promise((_, reject) => {
      stopped = () => reject(combined.reason);
      combined.addEventListener("abort", stopped, { once: true });
      timer = setTimeout(
        () => controller.abort(catalogueFailure("CATALOGUE_MEDIA_READ_TIMEOUT")),
        Math.max(1, Math.min(limits.fileTimeoutMs, deadline - Date.now())),
      );
    });
    const settlement = operation(combined).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      const result = await Promise.race([settlement, aborted]);
      if (result.error) throw result.error;
      combined.throwIfAborted();
      active();
      return result.value;
    } catch (failure) {
      let cleanupTimer;
      try {
        const settled = await Promise.race([
          settlement,
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(
              () => reject(cleanupFailure(failure)),
              limits.cleanupTimeoutMs,
            );
          }),
        ]);
        if (settled.error?.code === "MEDIA_FILE_CLEANUP") throw settled.error;
        throw failure;
      } finally {
        clearTimeout(cleanupTimer);
      }
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", stopped);
    }
  }
  return {
    active,
    probe: bounded,
    evidence: () => ({
      readBytes: bytes,
      hashes,
      identityChecks,
      maximumFileBytes: limits.fileBytes,
      maximumReadBytes: limits.totalBytes,
      maximumHashes: limits.hashes,
      maximumIdentityChecks: limits.identityChecks,
      fileTimeoutMs: limits.fileTimeoutMs,
      timeoutMs: limits.timeoutMs,
      cleanupTimeoutMs: limits.cleanupTimeoutMs,
    }),
    async assertParents(pin) {
      active();
      await bounded((combined) => assertParents(pin.parents ?? [], combined));
    },
    async assertIdentity(pin) {
      active();
      if (
        !isAbsolute(pin.path) ||
        resolve(pin.path) !== pin.path ||
        !isAbsolute(pin.boundary) ||
        !pin.path.startsWith(pin.boundary + sep)
      )
        throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
      if (++identityChecks > limits.identityChecks) throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
      await bounded(async (combined) => {
        await assertParents(pin.parents ?? [], combined);
        const leaf = await inspect(pin.path);
        if (
          !leaf.isFile() ||
          leaf.isSymbolicLink() ||
          !same(identity(leaf), pin.identity) ||
          (await canonical(pin.path)) !== pin.path
        )
          throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
        combined.throwIfAborted();
        const handle = await openFile(
          pin.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const current = await handle.stat();
          if (!current.isFile() || !same(identity(current), pin.identity))
            throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
          await assertParents(pin.parents ?? [], combined);
          const leafAfter = await inspect(pin.path),
            after = await handle.stat();
          if (
            !leafAfter.isFile() ||
            leafAfter.isSymbolicLink() ||
            !after.isFile() ||
            !same(identity(leafAfter), pin.identity) ||
            !same(identity(after), pin.identity)
          )
            throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
          if ((await canonical(pin.path)) !== pin.path)
            throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
        } finally {
          await closeMedia(handle);
        }
      });
    },
    async read(path, boundary) {
      active();
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        !isAbsolute(boundary) ||
        !path.startsWith(boundary + sep)
      )
        throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
      if (++hashes > limits.hashes) throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
      return bounded(async (combined) => {
        const ancestry = await parents(path, boundary, combined),
          leaf = await inspect(path);
        if (!leaf.isFile() || leaf.isSymbolicLink())
          throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
        if (leaf.size > limits.fileBytes || bytes + leaf.size > limits.totalBytes)
          throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
        await assertParents(ancestry, combined);
        if ((await canonical(path)) !== path) throw catalogueFailure("CATALOGUE_MEDIA_PATH_UNSAFE");
        combined.throwIfAborted();
        const handle = await openFile(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat();
          if (!before.isFile() || !same(identity(before), identity(leaf)))
            throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
          await assertParents(ancestry, combined);
          combined.throwIfAborted();
          const hash = createHash("sha256"),
            buffer = Buffer.alloc(64 * 1024);
          let received = 0;
          while (true) {
            active();
            combined.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            received += bytesRead;
            bytes += bytesRead;
            if (received > before.size || bytes > limits.totalBytes)
              throw catalogueFailure("CATALOGUE_MEDIA_LIMIT");
            hash.update(buffer.subarray(0, bytesRead));
          }
          const after = await handle.stat(),
            current = await inspect(path);
          await assertParents(ancestry, combined);
          if (
            received !== before.size ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            !same(identity(after), identity(before)) ||
            !same(identity(current), identity(before)) ||
            (await canonical(path)) !== path
          )
            throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
          combined.throwIfAborted();
          active();
          return {
            path,
            bytes: received,
            sha256: hash.digest("hex"),
            identity: identity(before),
            parents: ancestry,
            boundary,
          };
        } finally {
          await closeMedia(handle);
        }
      });
    },
  };
}
async function closeMedia(handle) {
  try {
    await handle.close();
  } catch (cause) {
    throw cleanupFailure(cause);
  }
}
function cleanupFailure(cause) {
  return markGlobalMediaSafety(
    Object.assign(
      new Error(
        "Retained-media read or descriptor closure is unconfirmed; retain containment and inspect owned I/O before retry.",
        { cause },
      ),
      { code: "MEDIA_FILE_CLEANUP", cleanup: "unconfirmed" },
    ),
  );
}
