import { CourseRefused } from "./ntulearn/read.mjs";

// Every course asked for, walked in turn on one session, with the courses NTULearn would not hand
// over carried out alongside the ones it did (ADR-0005).
//
// Anything else thrown ends the walk, because it is a fact about the run rather than about a
// course: a lapsed session would refuse every course after this one too, and one `npm run login`
// answers all of them.
//
// A refusal partway through a course leaves that course's earlier writes where they are — a sync
// only ever adds (ADR-0003), so a course that half-arrived is one to run again rather than to undo.
export async function walkCourses({ client, courses, walk }) {
  const walked = [];
  const refused = [];

  for (const course of courses) {
    try {
      walked.push(await walk({ client, course }));
    } catch (error) {
      if (!(error instanceof CourseRefused)) throw error;
      refused.push({ key: course.key, courseId: course.courseId, reason: error.message });
    }
  }

  return { courses: walked, refused };
}
