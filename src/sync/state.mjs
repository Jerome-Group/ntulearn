import { readFile } from "node:fs/promises";
import { writeAtomically } from "./files.mjs";

const STATE_VERSION = 1;

export const EMPTY_COURSE_STATE = Object.freeze({
  downloads: {},
  contentIds: [],
  announcementIds: [],
  conversationIds: [],
});

export async function readState(path) {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return { version: STATE_VERSION, courses: {}, ...(raw ? JSON.parse(raw) : {}) };
}

export function writeState(path, state) {
  return writeAtomically(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function courseState(state, key) {
  return state.courses[key] ?? EMPTY_COURSE_STATE;
}

export function newIds(current, previous = []) {
  const known = new Set(previous);
  return current.filter((id) => !known.has(id));
}
