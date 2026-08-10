const BASE_URL = "https://ntulearn.ntu.edu.sg";

export const COURSES_URL = `${BASE_URL}/ultra/course`;

export const SIGNED_IN_URL_PATTERN = `${BASE_URL}/ultra/**`;

export function courseUrl(courseId) {
  return `${BASE_URL}/ultra/courses/${courseId}/outline`;
}

export function absoluteUrl(pathOrUrl) {
  return new URL(pathOrUrl, BASE_URL).href;
}
