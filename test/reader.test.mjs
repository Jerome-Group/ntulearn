import assert from "node:assert/strict";
import test from "node:test";
import { NtulearnReader } from "../src/ntulearn/reader.mjs";
import { expectedFiles } from "../src/sync/expected.mjs";

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

test("recovers interaction metadata without requesting assessments or course-link targets", async () => {
  const requests = [];
  const reader = new NtulearnReader(async (path) => {
    requests.push(path);
    if (path === "/learn/api/v1/courses/synthetic") return { displayName: "Synthetic" };
    if (path.includes("/children?")) {
      return {
        results: [
          {
            id: "assessment",
            title: "Weekly check",
            position: 0,
            contentHandler: "resource/x-bb-asmt-test-link",
            genericReadOnlyData: { dueDate: "2026-10-30T15:59:00.000Z" },
            contentDetail: { "resource/x-bb-asmt-test-link": { test: {} } },
          },
          {
            id: "link",
            title: "Weekly conversation",
            position: 1,
            contentHandler: "resource/x-bb-courselink",
            contentDetailUrl: "/learn/api/v1/courses/synthetic/contents/target",
            contentDetail: {
              "resource/x-bb-courselink": {
                courseContent: "link",
                linkSourceId: "target",
                linkSourceTable: "CONTENT",
              },
            },
          },
        ],
      };
    }
    if (path.includes("/announcements?") || path.includes("/conversations?"))
      return { results: [] };
    assert.fail(`Unexpected acquisition: ${path}`);
  });
  const snapshot = await reader.readCourse("synthetic");
  const files = [];
  for await (const each of expectedFiles({ client: reader, courseId: "synthetic", snapshot }))
    files.push(each);
  assert.deepEqual(
    files.map((each) => each.kind),
    ["document", "document", "document"],
  );
  assert.deepEqual(requests.sort(), [
    "/learn/api/v1/courses/synthetic",
    "/learn/api/v1/courses/synthetic/announcements?limit=1000&offset=0&sort=startDateRestriction(desc)",
    "/learn/api/v1/courses/synthetic/contents/ROOT/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=false&limit=1000&offset=0",
    "/learn/api/v1/courses/synthetic/conversations?limit=1000&offset=0",
  ]);
});
