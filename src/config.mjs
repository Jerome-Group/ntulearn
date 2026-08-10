import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function loadConfig(root) {
  const path = resolve(root, "config/courses.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  const courses = raw.courses ?? [];
  const keys = new Set();

  for (const course of courses) {
    if (!course.key || !course.courseId || !course.destination) {
      throw new Error("Each course needs key, courseId, and destination.");
    }
    if (keys.has(course.key)) throw new Error(`Duplicate course key: ${course.key}`);
    keys.add(course.key);
  }

  return {
    profilePath: resolve(root, raw.profilePath ?? ".data/chrome-profile"),
    statePath: resolve(root, raw.statePath ?? ".data/state.json"),
    courses: courses.map((course) => ({
      ...course,
      destination: isAbsolute(course.destination) ? course.destination : resolve(root, course.destination),
    })),
  };
}
