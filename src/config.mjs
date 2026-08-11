import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const CONFIG_PATH = "config/courses.json";
const EXAMPLE_PATH = "config/courses.example.json";
const DEFAULT_PROFILE_PATH = ".data/chrome-profile";
const DEFAULT_STATE_PATH = ".data/state.json";
const REQUIRED_FIELDS = ["key", "courseId", "destination"];
const ALL = "all";
const OWN_FOLDER = "Give each NTULearn site its own folder.";

export async function loadConfig(root) {
  const raw = await readFile(resolve(root, CONFIG_PATH), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`No ${CONFIG_PATH}. Copy ${EXAMPLE_PATH} to it and edit it.`, {
      cause: error,
    });
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error.message}`, { cause: error });
  }

  return {
    profilePath: resolve(root, parsed.profilePath ?? DEFAULT_PROFILE_PATH),
    statePath: resolve(root, parsed.statePath ?? DEFAULT_STATE_PATH),
    courses: readCourses(parsed.courses ?? [], root),
  };
}

export function selectCourses(courses, key) {
  if (!key || key === ALL) return courses;
  const selected = courses.filter((course) => course.key.toLowerCase() === key.toLowerCase());
  if (!selected.length) throw new Error(`Unknown course: ${key}`);
  return selected;
}

function readCourses(courses, root) {
  const keys = new Set();
  const claimed = new Map();

  return courses.map((course) => {
    const missing = REQUIRED_FIELDS.filter((field) => !course[field]);
    if (missing.length) throw new Error(`A course in ${CONFIG_PATH} has no ${missing.join(", ")}.`);

    // Lower-cased because `selectCourses` matches that way, so two keys differing only in case are
    // one key at the command line and `sync -- ab1234` would run both courses.
    const key = course.key.toLowerCase();
    if (keys.has(key)) throw new Error(`Duplicate course key: ${course.key}`);
    keys.add(key);

    // `resolve` leaves an absolute path absolute and normalises it either way, which the
    // comparison below depends on: a trailing separator or a `..` segment in a hand-edited path
    // would otherwise make one folder read as two.
    const destination = resolve(root, course.destination);
    claim(claimed, course.key, destination);

    return { ...course, destination };
  });
}

// Two courses writing into one tree interleave their numbered folders, and a sync never deletes
// (ADR-0003) — so the tangle is permanent, and undoing it is hand work in somebody's own Drive.
// A destination nested inside another is the same fault: it is a tree both courses write.
function claim(claimed, key, destination) {
  const folder = comparable(destination);
  for (const [taken, claim] of claimed) {
    if (taken === folder) {
      throw new Error(
        `Courses ${claim.key} and ${key} share a destination: ${destination}. ${OWN_FOLDER}`,
      );
    }
    if (contains(folder, taken)) throw nestingError(claim.key, claim.path, key, destination);
    if (contains(taken, folder)) throw nestingError(key, destination, claim.key, claim.path);
  }
  claimed.set(folder, { key, path: destination });
}

// Lower-cased for the same reason the key is, and for a heavier consequence: macOS and Google
// Drive are both case-insensitive, so `…/NTULearn` and `…/ntulearn` are one folder there and would
// interleave. Refusing a pair that a case-sensitive filesystem would have kept apart costs a
// clearer configuration; accepting one that this filesystem merges costs the tangle ADR-0003
// cannot undo.
function comparable(destination) {
  return destination.toLowerCase();
}

function nestingError(inner, innerPath, outer, outerPath) {
  return new Error(
    `Course ${inner}'s destination ${innerPath} is inside course ${outer}'s ${outerPath}. ${OWN_FOLDER}`,
  );
}

// Deliberately not `safeResolve`'s containment test in `src/sync/paths.mjs`, which the two look
// alike enough to share: that one keeps a written path from escaping its root and must stay exact,
// and this one asks whether two configured folders overlap on the filesystem in hand.
function contains(folder, other) {
  return other.startsWith(`${folder}${sep}`);
}
