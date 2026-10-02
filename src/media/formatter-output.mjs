import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

const MAX_BYTES = 1024 * 1024;
const READ_BYTES = 64 * 1024;

export async function readFormatterAssistant(path, { prompt, signal, maxBytes = MAX_BYTES }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES)
    throw invalidEvidence();
  throwIfAborted(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    throwIfAborted(signal);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw invalidEvidence();
    const chunks = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const buffer = Buffer.alloc(Math.min(READ_BYTES, maxBytes - total + 1));
      const { bytesRead } = await file.read(buffer);
      throwIfAborted(signal);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw invalidEvidence();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const record = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const prefix = `User:\n${prompt}\n\nAssistant:\n`;
    if (!record.startsWith(prefix)) throw invalidEvidence();
    const assistant = record.slice(prefix.length).trim();
    if (!assistant) throw invalidEvidence();
    return assistant;
  } finally {
    await file.close();
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new Error("Formatter read interrupted. Retry formatting.");
}

function invalidEvidence() {
  const error = new Error(
    "Formatter output evidence is invalid. Check the pinned runtime, then retry formatting.",
  );
  error.code = "MEDIA_FORMATTER_RECORD";
  return error;
}
