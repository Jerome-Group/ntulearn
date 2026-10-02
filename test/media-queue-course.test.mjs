import assert from "node:assert/strict";
import test from "node:test";
import { queueCourseBoundary } from "../src/media/queue-course.mjs";

const course = { key: "synthetic", courseId: "course", destination: "/configured" };
const job = (destination, fields = {}) => ({
  courseId: course.courseId,
  placement: { destination },
  ...fields,
});
const directory = async () => ({ isDirectory: () => true });

test("queue boundary caches positive directory identity per distinct destination", async () => {
  const calls = [];
  const boundary = queueCourseBoundary({
    course,
    resolvePath: async (path) => {
      calls.push(path);
      return "/physical";
    },
    inspect: directory,
  });
  await boundary.assert(
    Array.from({ length: 100 }, () => job("/alias")),
    course.courseId,
  );
  await boundary.assert([job("/alias"), job("/configured")], course.courseId);
  assert.deepEqual(calls, ["/configured", "/configured", "/alias", "/alias"]);
  assert.equal(boundary.placementKey("/alias"), "/physical");
  assert.equal(boundary.placementKey("/configured"), "/physical");
});

test("lexically equal offline destinations need no filesystem access", async () => {
  const boundary = queueCourseBoundary({
    course,
    resolvePath: async () => assert.fail("no physical probe"),
    inspect: async () => assert.fail("no physical probe"),
  });
  await boundary.assert([job(course.destination)], course.courseId);
});

test("course, malformed placement and different physical directory fail closed", async () => {
  const boundary = queueCourseBoundary({
    course,
    resolvePath: async (path) => path,
    inspect: directory,
  });
  for (const value of [
    job("/alias", { courseId: "other" }),
    job("/alias", { courseKey: "other" }),
    null,
    job("relative"),
    job(42),
    job("/alias", { placement: [] }),
    job("/alias", { placement: {} }),
  ]) {
    await assert.rejects(
      boundary.assert([value], course.courseId),
      /review the course configuration/,
    );
  }
  await assert.rejects(
    boundary.assert([job("/alias")], course.courseId),
    /another physical destination/,
  );
});

test("missing, unreadable, non-directory and changing aliases keep actionable sanitized errors", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const cause = Object.assign(new Error("synthetic-private-path"), { code });
    const boundary = queueCourseBoundary({
      course,
      resolvePath: async () => {
        throw cause;
      },
      inspect: directory,
    });
    await assert.rejects(boundary.assert([job("/alias")], course.courseId), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.cause, cause);
      assert.match(error.message, /restore accessible course folders/);
      assert.equal(error.message.includes("synthetic-private"), false);
      return true;
    });
  }
  const file = queueCourseBoundary({
    course,
    resolvePath: async () => "/physical",
    inspect: async () => ({ isDirectory: () => false }),
  });
  await assert.rejects(
    file.assert([job("/alias")], course.courseId),
    /cannot be positively verified/,
  );
  let changed = false;
  const changing = queueCourseBoundary({
    course,
    resolvePath: async () => {
      changed = !changed;
      return changed ? "/one" : "/two";
    },
    inspect: directory,
  });
  await assert.rejects(
    changing.assert([job("/alias")], course.courseId),
    /cannot be positively verified/,
  );
});

test("logical resolution deadline and destination count stop verification before further work", async () => {
  const boundary = queueCourseBoundary({
    course,
    timeoutMs: 20,
    resolvePath: async () => new Promise(() => {}),
    inspect: directory,
  });
  await assert.rejects(
    boundary.assert([job("/alias")], course.courseId),
    /cannot be positively verified/,
  );
  const many = queueCourseBoundary({
    course,
    resolvePath: async () => "/physical",
    inspect: directory,
  });
  await assert.rejects(
    many.assert(
      Array.from({ length: 256 }, (_, index) => job(`/alias-${index}`)),
      course.courseId,
    ),
    /too many distinct destinations/,
  );
  assert.throws(() => queueCourseBoundary({ course, timeoutMs: 5001 }), /at most five seconds/);
});
