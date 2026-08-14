import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeIfChanged(path, content) {
  if ((await readText(path)) === content) return false;
  await writeAtomically(path, content);
  return true;
}

// A partial file is never left at `path`: the write lands beside it and is renamed over it.
export async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part-${process.pid}`;
  try {
    await writeFile(partial, content);
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
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

export function readText(path) {
  return readFile(path, "utf8").catch(missingAsNull);
}

function missingAsNull(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}
