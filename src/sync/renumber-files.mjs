import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertDestinationPath } from "./paths.mjs";

const PREFIX = ".ntulearn-renumber-";
const MANIFEST_LIMIT = 4096;
const ENTRY_LIMIT = 10000;
const DEPTH_LIMIT = 64;
const CLAIM_LIMIT = 128;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PROOFS = new Set(["walk-bytes", "current-page", "attachment-state"]);
const TAKEN = "the name it wants is held by something else";

/** @typedef {{kind: "walk-bytes" | "current-page" | "attachment-state", sha256: string, bytes: number}} FileProof */

/** Claim, prove, and exclusively publish one regular inode. Public names are never unlinked. */
export async function renumberFile({ destination, from, to, proof }) {
  from = resolve(from);
  to = resolve(to);
  if (dirname(from) !== dirname(to) || from === to || !validProof(proof))
    return {
      kind: "kept",
      why: "Invalid renumber request. Use distinct sibling file names and sync proof before retrying.",
    };
  await assertDestinationPath(destination, dirname(from));
  if (!validName(basename(from)) || !validName(basename(to)))
    return {
      kind: "kept",
      why: "Invalid or reserved renumber name. Choose ordinary sibling file names before retrying.",
    };
  const pending = await renumberRecoveries(destination);
  if (pending.length) return { kind: "recovery", ...pending[0] };
  try {
    if (await lstat(to).catch(missingAsNull)) return { kind: "kept", why: TAKEN };
  } catch (error) {
    return {
      kind: "kept",
      why: `Target could not be safely inspected (${error.code}). Repair the target directory and permissions before retrying.`,
    };
  }

  proof = { kind: proof.kind, sha256: proof.sha256, bytes: proof.bytes };
  const id = randomUUID();
  const claimPath = join(dirname(from), PREFIX + id);
  const payload = join(claimPath, "payload");
  const manifestPath = join(claimPath, "manifest.json");
  const manifest = { schemaVersion: 1, id, fromName: basename(from), toName: basename(to), proof };
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    const retained = await lstat(claimPath).catch((failure) =>
      failure.code === "ENOENT" ? null : true,
    );
    if (retained)
      return {
        kind: "recovery",
        claimPath,
        from,
        to,
        publication: "absent",
        restoration: "not-needed",
        why: recoveryAction(claimPath, `Renumber preparation interrupted (${error.code})`),
      };
    return {
      kind: "kept",
      why: `Could not prepare renumber storage (${error.code}). Repair the destination permissions before retrying.`,
    };
  }

  let publication = "absent";
  try {
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
    await rename(from, payload);
    const handle = await open(payload, READ_FLAGS);
    try {
      if (!(await matchesProof(handle, proof)))
        throw refusal("Captured bytes no longer match sync proof");
    } finally {
      await handle.close();
    }
    publication = "uncertain";
    try {
      await link(payload, to);
    } catch (error) {
      if (error.code === "EEXIST") publication = "absent";
      throw error;
    }
    publication = "linked";
    await unlink(payload);
    await unlink(manifestPath);
    await rmdir(claimPath);
    return { kind: "moved", from, to };
  } catch (error) {
    const restoration = publication === "linked" ? "not-needed" : await restore(payload, from);
    return {
      kind: "recovery",
      claimPath,
      from,
      to,
      publication,
      restoration,
      why: recoveryAction(
        claimPath,
        error.code === "RENUMBER_REFUSED" ? error.message : `Renumber interrupted (${error.code})`,
      ),
    };
  }
}

async function matchesProof(handle, proof) {
  const info = await handle.stat();
  if (!info.isFile()) throw refusal("Captured source is not a regular file");
  if (info.size !== proof.bytes) return false;
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(65536);
  let bytes = 0;
  for (;;) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, proof.bytes - bytes + 1),
      bytes,
    );
    if (!bytesRead) return bytes === proof.bytes && hash.digest("hex") === proof.sha256;
    bytes += bytesRead;
    if (bytes > proof.bytes) return false;
    hash.update(chunk.subarray(0, bytesRead));
  }
}

async function restore(payload, from) {
  try {
    const info = await lstat(payload).catch(missingAsNull);
    if (!info) return "not-needed";
    if (!info.isFile()) return "nonfile-retained";
    await link(payload, from);
    return "linked-and-retained";
  } catch (error) {
    return error.code === "EEXIST" ? "occupied" : "failed";
  }
}

/** Discover incomplete claims read-only before any new capture. Never follow descendants or replay intent. */
export async function renumberRecoveries(destination) {
  const found = [];
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
    return [
      {
        claimPath: resolve(destination),
        publication: "uncertain",
        restoration: "unexamined",
        why: "Safe no-follow and nonblocking file inspection is unavailable. Run renumber on a platform providing both flags before retrying; no claims were inspected or captured.",
      },
    ];
  let entries = 0;
  let stopped = false;
  async function visit(directory, depth) {
    if (stopped) return;
    if (depth > DEPTH_LIMIT) return stop(directory, "Recovery discovery depth limit reached");
    try {
      await assertDestinationPath(destination, directory);
      const listing = await opendir(directory);
      for await (const entry of listing) {
        if (++entries > ENTRY_LIMIT)
          return stop(directory, "Recovery discovery entry limit reached");
        const path = join(directory, entry.name);
        if (entry.name.startsWith(PREFIX)) {
          found.push(await inspectClaim(path));
          if (found.length >= CLAIM_LIMIT)
            return stop(directory, "Recovery discovery claim limit reached");
        } else if (entry.isDirectory()) {
          const info = await lstat(path);
          if (info.isDirectory()) await visit(path, depth + 1);
        }
        if (stopped) return;
      }
    } catch (error) {
      if (error.code !== "ENOENT" || depth !== 0)
        stop(
          directory,
          `Recovery discovery could not inspect this directory (${error.code ?? "unsafe path"})`,
        );
    }
  }
  function stop(claimPath, reason) {
    stopped = true;
    found.push({
      claimPath,
      publication: "uncertain",
      restoration: "unexamined",
      why: `${reason}. Renumber stopped before new work. Inspect ${claimPath} for retained .ntulearn-renumber- directories without deleting course data. Repair access or choose a destination within the discovery limits before retrying.`,
    });
  }
  await visit(resolve(destination), 0);
  return found;
}

async function inspectClaim(claimPath) {
  const result = { claimPath, publication: "uncertain", restoration: "unexamined" };
  try {
    if (!(await lstat(claimPath)).isDirectory())
      throw refusal("Recovery path is not a real directory");
    const manifest = await readManifest(join(claimPath, "manifest.json"));
    if (!validManifest(manifest, basename(claimPath)))
      throw refusal("Recovery intent is malformed");
    result.from = join(dirname(claimPath), manifest.fromName);
    result.to = join(dirname(claimPath), manifest.toName);
    const payload = await lstat(join(claimPath, "payload")).catch(missingAsNull);
    const reason = !payload
      ? "Incomplete renumber claim has no captured payload"
      : payload.isFile()
        ? "Retained renumber file requires inspection"
        : "Retained renumber payload is not a regular file";
    return { ...result, why: recoveryAction(claimPath, reason) };
  } catch (error) {
    return {
      ...result,
      why: recoveryAction(
        claimPath,
        error.code === "RENUMBER_REFUSED"
          ? error.message
          : `Recovery intent could not be read (${error.code ?? "invalid JSON"})`,
      ),
    };
  }
}

async function readManifest(path) {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MANIFEST_LIMIT)
      throw refusal("Recovery intent is not a bounded regular file");
    const body = Buffer.alloc(MANIFEST_LIMIT + 1);
    let used = 0;
    while (used < body.length) {
      const { bytesRead } = await handle.read(body, used, body.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MANIFEST_LIMIT) throw refusal("Recovery intent exceeds its size limit");
    return JSON.parse(body.subarray(0, used).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function validManifest(value, name) {
  return (
    value?.schemaVersion === 1 &&
    /^[a-f0-9-]{36}$/.test(value.id ?? "") &&
    name === PREFIX + value.id &&
    validName(value.fromName) &&
    validName(value.toName) &&
    value.fromName !== value.toName &&
    validProof(value.proof)
  );
}

function validName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0]/.test(value) &&
    !value.startsWith(PREFIX)
  );
}

function validProof(value) {
  return (
    PROOFS.has(value?.kind) &&
    /^[a-f0-9]{64}$/.test(value?.sha256 ?? "") &&
    Number.isSafeInteger(value?.bytes) &&
    value.bytes >= 0
  );
}

function recoveryAction(path, reason) {
  return `${reason}. Renumber stopped. Inspect ${path} and both public names; preserve the captured bytes, restore only to an empty name, and remove the claim only after verifying recovery. Then retry renumber.`;
}

function refusal(message) {
  const error = new Error(message);
  error.code = "RENUMBER_REFUSED";
  return error;
}

function missingAsNull(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}
