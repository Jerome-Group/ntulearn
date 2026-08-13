import assert from "node:assert/strict";
import test from "node:test";
import { walkCourses } from "../src/courses.mjs";
import { CourseRefused } from "../src/ntulearn/read.mjs";

const CLIENT = { name: "the one session" };

// The three that refuse and the one that reads fine are #66's own: two closed courses from last
// semester, with a live one between them, so a refusal is shown not to take the courses after it.
const COURSES = [
  { key: "SLAF01", courseId: "_2694562_1", destination: "/tmp/one" },
  { key: "PS0002-LAB", courseId: "_2751801_1", destination: "/tmp/two" },
  { key: "PH1198-LAB", courseId: "_2693075_1", destination: "/tmp/three" },
];

function refusing(...refusedKeys) {
  return async ({ course }) => {
    if (refusedKeys.includes(course.key)) {
      throw new CourseRefused(`NTULearn refused course ${course.courseId}`);
    }
    return { key: course.key, files: 1 };
  };
}

test("walks every course and hands back what each one said", async () => {
  const walked = [];
  const result = await walkCourses({
    client: CLIENT,
    courses: COURSES,
    walk: async ({ client, course }) => {
      assert.equal(client, CLIENT);
      walked.push(course.key);
      return { key: course.key };
    },
  });

  assert.deepEqual(walked, ["SLAF01", "PS0002-LAB", "PH1198-LAB"]);
  assert.deepEqual(
    result.courses.map((course) => course.key),
    ["SLAF01", "PS0002-LAB", "PH1198-LAB"],
  );
  assert.deepEqual(result.refused, []);
});

// The issue: one course closing at the end of a semester took the report for the other sixteen with
// it, and a scheduled run that has said nothing for weeks reads exactly like one that is passing.
test("a course that refuses does not stop the courses after it", async () => {
  const result = await walkCourses({
    client: CLIENT,
    courses: COURSES,
    walk: refusing("SLAF01", "PH1198-LAB"),
  });

  assert.deepEqual(
    result.courses.map((course) => course.key),
    ["PS0002-LAB"],
  );
  assert.deepEqual(
    result.refused.map((course) => course.key),
    ["SLAF01", "PH1198-LAB"],
  );
});

test("a refused course is named, and says why it was not read", async () => {
  const { refused } = await walkCourses({
    client: CLIENT,
    courses: COURSES,
    walk: refusing("SLAF01"),
  });

  assert.deepEqual(refused, [
    {
      key: "SLAF01",
      courseId: "_2694562_1",
      reason: "NTULearn refused course _2694562_1",
    },
  ]);
});

// A session that has lapsed is not a fact about any one course: every course after this one would
// refuse too, and the remedy — a person at an MFA prompt — is the same for all of them.
test("a failure that is not a course refusing still ends the run", async () => {
  await assert.rejects(
    walkCourses({
      client: CLIENT,
      courses: COURSES,
      walk: async () => {
        throw new Error("The saved session is no longer signed in. Run: npm run login");
      },
    }),
    /npm run login/,
  );
});
