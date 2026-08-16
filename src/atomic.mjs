import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// A partial file is never left at `path`: the write lands beside it and is renamed over it.
export async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part-${randomUUID()}`;
  try {
    await writeFile(partial, content);
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}
