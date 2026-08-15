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
  assert.equal(config.driveMountPath, null);
  assert.equal(config.watchdogTimeoutMs, 900_000);
  assert.deepEqual(config.courses, []);
});

test("resolves the Drive mount and keeps an explicit watchdog timeout", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      driveMountPath: "Google Drive",
      watchdogTimeoutMs: 12_345,
      courses: [],
    }),
  );
  const config = await loadConfig(root);
  assert.equal(config.driveMountPath, resolve(root, "Google Drive"));
  assert.equal(config.watchdogTimeoutMs, 12_345);
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

test("rejects two courses sharing a key however it is cased", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "AB1234", courseId: "_1_1", destination: "out/a" },
        { key: "ab1234", courseId: "_2_1", destination: "out/b" },
      ],
    }),
  );
  await assert.rejects(loadConfig(root), /Duplicate course key: ab1234/);
});

test("rejects two courses whose destinations are the same folder", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "CC0006", courseId: "_1_1", destination: "/srv/CC0006/NTULearn" },
        { key: "CC0006-TUT", courseId: "_2_1", destination: "/srv/CC0006/NTULearn" },
      ],
    }),
  );
  await assert.rejects(
    loadConfig(root),
    /CC0006 and CC0006-TUT share a destination.*Give each NTULearn site its own folder/s,
  );
});

test("rejects a destination sitting inside another course's", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "CC0006", courseId: "_1_1", destination: "/srv/CC0006/NTULearn" },
        { key: "CC0006-TUT", courseId: "_2_1", destination: "/srv/CC0006/NTULearn/Tutorial" },
      ],
    }),
  );
  await assert.rejects(
    loadConfig(root),
    /CC0006-TUT.*is inside.*CC0006.*Give each NTULearn site its own folder/s,
  );
});

// A destination is hand-edited JSON, so a trailing separator or a `..` is ordinary rather than
// exotic — and either one used to make a nested folder read as an unrelated one (#34).
test("sees through the ways a hand-written path can spell the same folder", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "CC0006", courseId: "_1_1", destination: "/srv/CC0006/NTULearn/" },
        { key: "CC0006-TUT", courseId: "_2_1", destination: "/srv/CC0006/x/../NTULearn/Tutorial" },
      ],
    }),
  );
  await assert.rejects(loadConfig(root), /is inside course CC0006's/);
});

// macOS and Google Drive are both case-insensitive, so these are one folder on the machine this
// runs on, and two courses would interleave into it.
test("rejects destinations that differ only in case", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "CC0006", courseId: "_1_1", destination: "/srv/CC0006/NTULearn" },
        { key: "CC0006-TUT", courseId: "_2_1", destination: "/srv/CC0006/ntulearn" },
      ],
    }),
  );
  await assert.rejects(loadConfig(root), /share a destination/);
});

test("takes two sites of one course as the siblings they are", async () => {
  const root = await repositoryWith(
    JSON.stringify({
      courses: [
        { key: "CC0006", courseId: "_1_1", destination: "/srv/CC0006/NTULearn" },
        { key: "CC0006-TUT", courseId: "_2_1", destination: "/srv/CC0006/NTULearn_Tutorial" },
      ],
    }),
  );
  const { courses } = await loadConfig(root);
  assert.deepEqual(
    courses.map((course) => course.destination),
    ["/srv/CC0006/NTULearn", "/srv/CC0006/NTULearn_Tutorial"],
  );
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
