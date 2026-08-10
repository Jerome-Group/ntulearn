import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig, selectCourses } from "../src/config.mjs";

async function repositoryWith(config) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-config-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/courses.json"), config);
  return root;
}

test("defaults the profile and state paths, and resolves them against the root", async () => {
  const root = await repositoryWith(JSON.stringify({ courses: [] }));
  const config = await loadConfig(root);
  assert.equal(config.profilePath, resolve(root, ".data/chrome-profile"));
  assert.equal(config.statePath, resolve(root, ".data/state.json"));
  assert.deepEqual(config.courses, []);
});

test("keeps an absolute destination and resolves a relative one", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "AB1234", courseId: "_1_1", destination: "/srv/Modules/AB1234" },
        { key: "CD5678", courseId: "_2_1", destination: "out/CD5678" },
      ],
    }),
  );
  const { courses } = await loadConfig(root);
  assert.equal(courses[0].destination, "/srv/Modules/AB1234");
  assert.equal(courses[1].destination, resolve(root, "out/CD5678"));
});

test("names the field a course is missing", async () => {
  const root = await repositoryWith(JSON.stringify({ courses: [{ key: "AB1234" }] }));
  await assert.rejects(loadConfig(root), /has no courseId, destination/);
});

test("rejects two courses sharing a key", async () => {
  const course = { key: "AB1234", courseId: "_1_1", destination: "out" };
  const root = await repositoryWith(JSON.stringify({ courses: [course, course] }));
  await assert.rejects(loadConfig(root), /Duplicate course key: AB1234/);
});

test("says which file is unreadable rather than reporting a bare syntax error", async () => {
  const root = await repositoryWith("{ not json");
  await assert.rejects(loadConfig(root), /config\/courses\.json is not valid JSON/);
});

test("points at the example when there is no configuration at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-config-"));
  await assert.rejects(loadConfig(root), /Copy config\/courses\.example\.json/);
});

test("selects every course for no argument and for 'all'", () => {
  const courses = [{ key: "AB1234" }, { key: "CD5678" }];
  assert.deepEqual(selectCourses(courses, undefined), courses);
  assert.deepEqual(selectCourses(courses, "all"), courses);
});

test("selects one course by key, case-insensitively", () => {
  const courses = [{ key: "AB1234" }, { key: "CD5678" }];
  assert.deepEqual(selectCourses(courses, "ab1234"), [{ key: "AB1234" }]);
});

test("rejects a key that is not configured", () => {
  assert.throws(() => selectCourses([{ key: "AB1234" }], "ZZ9999"), /Unknown course: ZZ9999/);
});
