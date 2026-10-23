import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";

const writers = new AsyncLocalStorage();
const trace = [];
const allowed = new Set([
  "lstat:destination",
  "readFile:destination",
  "mkdir:parent",
  "writeFile:private",
  "rename:private,private",
  "rename:private,destination",
  "link:private,destination",
  "unlink:private",
]);
let destination;
let concurrent;
let absentCount = 0;
let releaseInspections;
let releaseWinner;
const inspections = new Promise((resolve) => (releaseInspections = resolve));
const winner = new Promise((resolve) => (releaseWinner = resolve));

export function configure(path, race) {
  destination = resolve(path);
  concurrent = race;
}

export function asWriter(id, action) {
  return writers.run(id, action);
}

export function events() {
  return trace;
}

export async function occupant(path) {
  const info = await fs.lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return { kind: "absent" };
  const identity = `${info.dev}:${info.ino}`;
  if (info.isSymbolicLink()) {
    return { kind: "symlink", identity, target: await fs.readlink(path) };
  }
  if (!info.isFile()) return { kind: "directory", identity };
  const bytes = await fs.readFile(path);
  return {
    kind: "file",
    identity,
    bytes: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function classify(path) {
  const absolute = resolve(path);
  if (absolute === destination) return "destination";
  if (absolute === dirname(destination)) return "parent";
  const suffix = absolute.slice(destination.length);
  if (absolute.startsWith(destination) && /^(?:\.part-[0-9a-f-]{36}){1,2}$/.test(suffix)) {
    return "private";
  }
  throw new Error(`Unmapped filesystem path ${absolute}. Review publication mapping.`);
}

async function call(operation, paths, options = []) {
  const id = writers.getStore();
  if (!id) throw new Error("Filesystem call outside a named publication writer.");
  const classes = paths.map(classify);
  const signature = `${operation}:${classes.join(",")}`;
  if (!allowed.has(signature)) {
    throw new Error(`Unmapped filesystem operation ${signature}. Review publication mapping.`);
  }
  const publishes = classes[1] === "destination";
  if (concurrent && publishes && id === "B") await winner;
  const event = { writer: id, operation, paths, classes };
  trace.push(event);
  try {
    const result = await fs[operation](...paths, ...options);
    event.result = "ok";
    if (publishes) event.occupant = await occupant(destination);
    return result;
  } catch (error) {
    event.result = error.code ?? error.message;
    if (concurrent && operation === "lstat" && error.code === "ENOENT") {
      absentCount += 1;
      if (absentCount === 2) releaseInspections();
      await inspections;
    }
    throw error;
  } finally {
    if (publishes && id === "A") releaseWinner();
  }
}

export const lstat = (path) => call("lstat", [path]);
export const readFile = (path, ...options) => call("readFile", [path], options);
export const mkdir = (path, ...options) => call("mkdir", [path], options);
export const writeFile = (path, ...options) => call("writeFile", [path], options);
export const rename = (from, to) => call("rename", [from, to]);
export const link = (from, to) => call("link", [from, to]);
export const unlink = (path) => call("unlink", [path]);
export const stat = (path) => call("stat", [path]);
