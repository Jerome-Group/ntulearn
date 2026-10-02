import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, stat, unlink } from "node:fs/promises";
import { writeAtomically } from "../atomic.mjs";

export { writeAtomically };

export async function writeWithoutReplacing(path, content) {
  const body = Buffer.from(content);
  try {
    if (await identicalOrAbsent(path, body)) return false;
    const partial = `${path}.part-${randomUUID()}`;
    try {
      await writeAtomically(partial, body);
      try {
        await link(partial, path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await identicalOrAbsent(path, body)) return false;
        throw destinationConflict();
      }
      return true;
    } finally {
      await unlink(partial).catch(missingAsNull);
    }
  } catch (error) {
    if (error.code === "SYNC_FILE_CONFLICT") throw error;
    const failure = new Error(
      "Course file could not be safely inspected or published. Restore or repair the destination directory and permissions, or choose a filesystem supporting exclusive hard-link publication before retrying; sync will not replace existing files.",
      { cause: error },
    );
    failure.code = error.code;
    throw failure;
  }
}

async function identicalOrAbsent(path, body) {
  const info = await lstat(path).catch(missingAsNull);
  if (!info) return false;
  if (!info.isFile()) throw destinationConflict();
  const existing = await readFile(path);
  if (!existing.equals(body)) throw destinationConflict();
  return true;
}

function destinationConflict() {
  const error = new Error(
    "This destination already holds different bytes. Existing file was retained. Compare it with NTULearn and choose an empty destination before retrying; sync will not replace or rename it.",
  );
  error.code = "SYNC_FILE_CONFLICT";
  return error;
}

export async function isFilePresent(path, expectedBytes) {
  const info = await stat(path).catch(missingAsNull);
  return Boolean(info?.isFile()) && (expectedBytes == null || info.size === expectedBytes);
}

export async function isDirectoryPresent(path) {
  const info = await stat(path).catch(missingAsNull);
  return Boolean(info?.isDirectory());
}

// Whether the file at `path` is these very bytes — compared rather than assumed, wherever a run
// would otherwise leave in place, or write over, something it did not itself write (ADR-0009).
export async function fileHolds(path, body) {
  const existing = await readFile(path).catch(missingAsNull);
  return existing !== null && existing.equals(body);
}

// What the bytes at `path` hash to, against the digest a download recorded. It is the only evidence
// this repository has that a file in somebody's own folder is still the one it wrote (ADR-0010).
export async function fileDigest(path) {
  const body = await readFile(path).catch(missingAsNull);
  return body === null ? null : createHash("sha256").update(body).digest("hex");
}

// A file takes a new name without `rename`, which replaces whatever is already there silently —
// a delete, in the one operation this repository is most careful about (ADR-0003). The new name is
// claimed by a second link, which fails outright when the name is taken, and only then does the old
// name let go. Nothing is ever unlinked while it is the file's only name.
export async function relinkFile(from, to) {
  try {
    await link(from, to);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  await unlink(from);
  return true;
}

// A directory has no such trick, so the name is looked at first. The kernel is the backstop rather
// than the guard: `rename` refuses a name holding a file, or a directory with anything in it, and
// the only thing this could take away is an empty directory (ADR-0010).
export async function moveDirectory(from, to) {
  if ((await stat(to).catch(missingAsNull)) !== null) return false;
  await rename(from, to);
  return true;
}

export function readText(path) {
  return readFile(path, "utf8").catch(missingAsNull);
}

function missingAsNull(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}
