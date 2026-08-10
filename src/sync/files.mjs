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

export async function isFileOfSize(path, expectedBytes) {
  const info = await stat(path).catch(missingAsNull);
  return Boolean(info?.isFile()) && (expectedBytes == null || info.size === expectedBytes);
}

function readText(path) {
  return readFile(path, "utf8").catch(missingAsNull);
}

function missingAsNull(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}
