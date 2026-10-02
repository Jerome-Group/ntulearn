import assert from "node:assert/strict";
import test from "node:test";
import { NtulearnReader } from "../src/ntulearn/reader.mjs";

test("course list follows membership pages", async () => {
  const reader = new NtulearnReader(async (path) => {
    if (path.endsWith("/me")) return { id: "student" };
    if (path === "/next-memberships") return { results: [{ course: { id: "b" } }] };
    return { results: [{ course: { id: "a" } }], paging: { nextPage: "/next-memberships" } };
  });
  assert.deepEqual(
    (await reader.listCourses()).map((course) => course.id),
    ["a", "b"],
  );
});

test("course snapshot follows announcements, conversations and tree pages", async () => {
  const reader = new NtulearnReader(async (path) => {
    if (path.endsWith("/synthetic")) return { displayName: "Synthetic" };
    for (const category of ["announcements", "conversations", "children"]) {
      if (path === `/next-${category}`) return { results: [{ id: `${category}-second` }] };
      if (path.includes(`/${category}?`))
        return {
          results: [{ id: `${category}-first` }],
          paging: { nextPage: `/next-${category}` },
        };
    }
    assert.fail("unexpected synthetic request");
  });
  const snapshot = await reader.readCourse("synthetic");
  assert.deepEqual(
    snapshot.announcements.map((row) => row.id),
    ["announcements-first", "announcements-second"],
  );
  assert.deepEqual(
    snapshot.conversations.map((row) => row.id),
    ["conversations-first", "conversations-second"],
  );
  assert.deepEqual(
    snapshot.items.map((row) => row.id),
    ["children-first", "children-second"],
  );
});

test("later optional-unavailable stays explicit without poisoning the course tree", async () => {
  const reader = new NtulearnReader(async (path, { optional = false } = {}) => {
    if (path.endsWith("/synthetic")) return { displayName: "Synthetic" };
    if (path.includes("/announcements?"))
      return { results: [{ id: "first" }], paging: { nextPage: "/next-announcements" } };
    if (path === "/next-announcements") {
      assert.equal(optional, true);
      return { results: [], unavailable: true };
    }
    return { results: [] };
  });
  const snapshot = await reader.readCourse("synthetic");
  assert.deepEqual(snapshot.announcements, []);
  assert.equal(snapshot.unavailable.announcements, true);
});
