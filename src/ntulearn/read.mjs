const COURSE_IN_PATH = /\/courses\/([^/?]+)/;

// An optional read is one whose absence is not a defect — the announcements and the conversations,
// which this repository counts rather than depends on. NTULearn says "you get nothing" two ways:
// `404` where there is nothing there, and `403` where the student may not look. For a read nothing
// downstream requires, those are the same fact, and treating only the first as absence is what let
// a forbidden conversations read take a whole course down with it.
export function optionalIsMissing(status) {
  return status === 404 || status === 403;
}

// Why a read cannot be used, or `null` when it can.
//
// `401` and `403` are different facts with different remedies and were answered with the same
// sentence. `401` is *this session is no longer signed in*, and the remedy is a person at an MFA
// prompt. `403` is *this session is fine and this course is not yours* — a closed course, or one
// the student has been unenrolled from — and signing in again fixes nothing. Sending an unattended
// run to `npm run login` for a course that is merely closed is the failure this separates.
//
// Neither names the path. `readCourse` reads four things at once, so the path in a refusal is
// whichever of them lost the race — `25S1-CC0001-LEC-ALL` reported `/conversations` while its
// contents were forbidden too. Naming the course instead makes the refusal the same fact however
// the race went, and a refusal that changes wording run to run is one nobody can act on.
export function readRefusal({ status, path }) {
  if (status === 401) {
    return "The saved session is no longer signed in. Run: npm run login";
  }

  if (status === 403) {
    return `NTULearn refused ${courseIn(path)} for this student (HTTP 403). It may be closed, or the student may no longer be enrolled — the saved session is fine, so signing in again will not open it.`;
  }

  if (status < 200 || status >= 300) {
    return `NTULearn request failed for ${path}: HTTP ${status}`;
  }

  return null;
}

function courseIn(path) {
  const course = COURSE_IN_PATH.exec(path)?.[1];
  return course ? `course ${course}` : "this read";
}
