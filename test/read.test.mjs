import assert from "node:assert/strict";
import test from "node:test";
import { CourseRefused, optionalIsMissing, readRefusal } from "../src/ntulearn/read.mjs";

const CONTENTS = "/learn/api/v1/courses/_2694562_1/contents/ROOT/children?@view=Summary&limit=1000";
const CONVERSATIONS = "/learn/api/v1/courses/_2694562_1/conversations?limit=1000&offset=0";
const ME = "/learn/api/v1/users/me";

test("a read that arrived is not refused", () => {
  assert.equal(readRefusal({ status: 200, path: CONTENTS }), null);
});

test("a session that is not signed in says so, and says to sign in again", () => {
  const refusal = readRefusal({ status: 401, path: CONTENTS });
  assert.match(refusal.message, /npm run login/);
});

// The whole point of the issue: a `403` is the session working correctly and being told no. Sending
// the run to `npm run login` costs a person at an MFA prompt and fixes nothing.
test("a forbidden course does not tell anybody to sign in again", () => {
  const refusal = readRefusal({ status: 403, path: CONTENTS });
  assert.doesNotMatch(refusal.message, /npm run login/);
});

test("a forbidden course names the course, and says the session is not the problem", () => {
  const refusal = readRefusal({ status: 403, path: CONTENTS });
  assert.match(refusal.message, /_2694562_1/);
  assert.match(refusal.message, /session/i);
});

// `readCourse` fires four reads at once, so the path in a message is whichever lost the race.
// Naming the course rather than the path is what makes the failure the same either way.
test("two forbidden reads of one course refuse identically, whichever rejected first", () => {
  assert.equal(
    readRefusal({ status: 403, path: CONTENTS }).message,
    readRefusal({ status: 403, path: CONVERSATIONS }).message,
  );
});

// #66: a course that is merely closed is a fact about the course, and a command may carry it into
// its report rather than stop on it. Nothing downstream may tell it apart by reading the sentence.
test("a forbidden course is refused as a course", () => {
  assert.ok(readRefusal({ status: 403, path: CONTENTS }) instanceof CourseRefused);
});

test("a lapsed session is not a course refusing, whatever it was reading", () => {
  assert.ok(!(readRefusal({ status: 401, path: CONTENTS }) instanceof CourseRefused));
});

test("a forbidden read that is not about a course still refuses", () => {
  const refusal = readRefusal({ status: 403, path: ME });
  assert.match(refusal.message, /403/);
  assert.doesNotMatch(refusal.message, /npm run login/);
});

// There is no course to carry into a report and no course to leave out of one, so this is an
// ordinary failure: whatever is wrong with a read of the signed-in student is wrong with the run.
test("a forbidden read that is not about a course is not a course refusing", () => {
  assert.ok(!(readRefusal({ status: 403, path: ME }) instanceof CourseRefused));
});

test("any other failure names the path it failed on", () => {
  const refusal = readRefusal({ status: 500, path: CONTENTS });
  assert.match(refusal.message, /500/);
  assert.match(refusal.message, /contents/);
});

test("an optional read is missing when there is nothing there", () => {
  assert.equal(optionalIsMissing(404), true);
});

// The latent half of the issue: `optional` meant `404` only, so an announcements or conversations
// read the student may not make took the whole course down with it.
test("an optional read is missing when the student may not look", () => {
  assert.equal(optionalIsMissing(403), true);
});

test("an optional read that arrived is not missing", () => {
  assert.equal(optionalIsMissing(200), false);
});

test("an optional read is not missing because the server broke", () => {
  assert.equal(optionalIsMissing(500), false);
});
