const COURSE_IN_PATH = /\/courses\/([^/?]+)/;

// An optional read is one whose absence is not a defect — the announcements and the conversations,
// which this repository counts rather than depends on. NTULearn says "you get nothing" two ways:
// `404` where there is nothing there, and `403` where the student may not look. For a read nothing
// downstream requires, those are the same fact, and treating only the first as absence is what let
// a forbidden conversations read take a whole course down with it.
export function optionalIsMissing(status) {
  return status === 404 || status === 403;
}

// One named course NTULearn will not hand over to this student. It is a fact about the course and
// not about the run — a closed course stays closed however often the run is repeated — so a command
// may carry it into its report instead of stopping on it (#66). Every other refusal is an ordinary
// `Error` and still ends the run: a lapsed session has a remedy, and a course that closed has none.
export class CourseRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "CourseRefused";
  }
}

// Why a read cannot be used, as the error to throw, or `null` when it can. The error's *kind* is
// part of the answer and not the caller's to work out: reading the sentence back to tell a closed
// course from a lapsed session is what this returns a `CourseRefused` to avoid.
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
    return new Error("The saved session is no longer signed in. Run: npm run login");
  }

  if (status === 403) {
    const courseId = COURSE_IN_PATH.exec(path)?.[1];
    const message = `NTULearn refused ${courseId ? `course ${courseId}` : "this read"} for this student (HTTP 403). It may be closed, or the student may no longer be enrolled — the saved session is fine, so signing in again will not open it.`;
    // A read that names no course — the signed-in student's own record — leaves nothing to carry
    // into a report and nothing to leave out of one, so it is the run that is wrong.
    return courseId ? new CourseRefused(message) : new Error(message);
  }

  if (status < 200 || status >= 300) {
    return new Error(`NTULearn request failed for ${path}: HTTP ${status}`);
  }

  return null;
}
