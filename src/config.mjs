import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const CONFIG_PATH = "config/courses.json";
const EXAMPLE_PATH = "config/courses.example.json";
const DEFAULT_PROFILE_PATH = ".data/chrome-profile";
const DEFAULT_STATE_PATH = ".data/state.json";
const REQUIRED_FIELDS = ["key", "courseId", "destination"];
const ALL = "all";

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
  return courses.map((course) => {
    const missing = REQUIRED_FIELDS.filter((field) => !course[field]);
    if (missing.length) throw new Error(`A course in ${CONFIG_PATH} has no ${missing.join(", ")}.`);
    if (keys.has(course.key)) throw new Error(`Duplicate course key: ${course.key}`);
    keys.add(course.key);
    return {
      ...course,
      destination: isAbsolute(course.destination)
        ? course.destination
        : resolve(root, course.destination),
    };
  });
}
