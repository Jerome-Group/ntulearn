import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { writeWithoutReplacing } from "./files.mjs";
import { assertDestinationPath, safeSegment } from "./paths.mjs";
const PROVENANCE = "Source editions";
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function recordSourceEdition(destination, expected, path, accepted = null) {
  if (!expected.source) return;
  const relativePath = relative(destination, path);
  if (!validPath(relativePath)) throw Error("SOURCE_PATH_UNSAFE");
  await assertDestinationPath(destination, path);
  const { bytes, sha256 } = await sourceEvidence(path);
  const wanted = accepted ?? {
    sha256: hash(expected.content),
    bytes: Buffer.byteLength(expected.content),
  };
  if (sha256 !== wanted.sha256 || bytes !== wanted.bytes)
    throw Error(
      "Source changed after publication. Existing bytes were retained. Retry after storage settles.",
    );
  const record = {
    schemaVersion: 1,
    sourceIdentity: expected.source.identity,
    kind: expected.source.kind,
    version: expected.source.version,
    originalPath: expected.source.originalPath,
    relativePath,
    bytes,
    sha256,
  };
  const body = JSON.stringify(record) + "\n",
    directory = join(destination, PROVENANCE, expected.source.identity);
  await assertDestinationPath(destination, directory);
  await mkdir(directory, { recursive: true });
  const target = join(directory, hash(body) + ".json");
  await assertDestinationPath(destination, target);
  await writeWithoutReplacing(target, body);
}

export async function provenanceRecords(destination, source, { inspect = lstat } = {}) {
  const directory = join(destination, PROVENANCE, source.identity);
  await assertDestinationPath(destination, directory);
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (names.filter((name) => !nativeMetadataName(name)).length > 128)
    throw Error("Source provenance is too large. Inspect source editions before retrying.");
  const records = [];
  for (const name of names.sort()) {
    if (nativeMetadataName(name)) {
      const path = join(directory, name);
      await assertDestinationPath(destination, path);
      await qualifyNativeMetadata(path, name, inspect);
      continue;
    }
    if (/^[a-f0-9]{64}\.json(?:\.part-[a-f0-9-]{36}){1,2}$/.test(name)) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw Error("Source provenance is malformed. Restore its original records before retrying.");
    const path = join(directory, name);
    await assertDestinationPath(destination, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let body;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536)
        throw Error(
          "Source provenance is malformed. Restore its original records before retrying.",
        );
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 65536) throw Error("Source provenance grew. Retry after storage settles.");
      body = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    let record;
    try {
      record = JSON.parse(body);
    } catch {
      throw Error("Source provenance is malformed. Restore its original records before retrying.");
    }
    if (
      hash(body) !== name.slice(0, -5) ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.schemaVersion !== 1 ||
      record.sourceIdentity !== source.identity ||
      record.kind !== source.kind ||
      (source.kind === "announcement"
        ? !DIGEST.test(record.version ?? "")
        : record.version !== null) ||
      !validPath(record.relativePath) ||
      (record.originalPath != null && !validPath(record.originalPath)) ||
      !DIGEST.test(record.sha256 ?? "") ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0
    )
      throw Error(
        "Source provenance does not match its identity. Restore its original records before retrying.",
      );
    records.push(record);
  }
  return records;
}
function nativeMetadataName(name) {
  return name === "Icon\r" || name === ".DS_Store";
}

async function qualifyNativeMetadata(path, name, inspect) {
  const maximum = name === "Icon\r" ? 0 : 1024 * 1024;
  let file;
  const refuse = () =>
    Error(
      "Native source metadata is unqualified or changed. Inspect the retained metadata before retrying.",
    );
  try {
    const visibleBefore = await inspect(path);
    if (!visibleBefore.isFile() || visibleBefore.isSymbolicLink()) throw refuse();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum || !sameFile(before, visibleBefore))
      throw refuse();
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat(),
      visibleAfter = await inspect(path);
    if (
      length !== before.size ||
      length > maximum ||
      !visibleAfter.isFile() ||
      visibleAfter.isSymbolicLink() ||
      !sameFile(before, after) ||
      !sameFile(before, visibleAfter)
    )
      throw refuse();
    if (
      name === ".DS_Store" &&
      !buffer.subarray(0, length).subarray(0, 8).equals(Buffer.from("0000000142756431", "hex"))
    )
      throw refuse();
  } catch {
    throw refuse();
  } finally {
    await file?.close();
  }
}
function sameFile(first, second) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(
    (field) => first[field] === second[field],
  );
}

function validPath(path) {
  return (
    typeof path === "string" &&
    !isAbsolute(path) &&
    path.length <= 4096 &&
    path.split(sep).every((s) => s && s !== "." && s !== ".." && s === safeSegment(s))
  );
}

async function sourceEvidence(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw Error(
        "Source publication is not a regular file. Inspect the retained path before retrying.",
      );
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > before.size)
        throw Error("Source grew during evidence read. Retry after storage settles.");
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat(),
      visible = await lstat(path);
    if (
      bytes !== before.size ||
      !visible.isFile() ||
      [after, visible].some(
        (info) =>
          info.dev !== before.dev ||
          info.ino !== before.ino ||
          info.size !== before.size ||
          info.mtimeMs !== before.mtimeMs ||
          info.ctimeMs !== before.ctimeMs,
      )
    )
      throw Error("Source changed during evidence read. Retry after storage settles.");
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await file.close();
  }
}
