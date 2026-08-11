const BASE_URL = "https://ntulearn.ntu.edu.sg";
const IDENTITY_PROVIDERS = new Set(["login.microsoftonline.com", "idp.ntu.edu.sg"]);

export const COURSES_URL = `${BASE_URL}/ultra/course`;

export const SIGNED_IN_URL_PATTERN = `${BASE_URL}/ultra/**`;

export function courseUrl(courseId) {
  return `${BASE_URL}/ultra/courses/${courseId}/outline`;
}

export function absoluteUrl(pathOrUrl) {
  return new URL(pathOrUrl, BASE_URL).href;
}

export function isNtulearnUrl(pathOrUrl) {
  try {
    return new URL(pathOrUrl, BASE_URL).origin === BASE_URL;
  } catch {
    return false;
  }
}

// Signing in is a round trip through NTU's identity provider and back, so an attempt that has not
// arrived stopped in one of two places, and they want opposite advice. Parked at the provider, it
// is waiting for a person and only a login clears it; anywhere else it is still in flight, and the
// thing to do is ask again.
export function isIdentityProviderUrl(pathOrUrl) {
  try {
    return IDENTITY_PROVIDERS.has(new URL(pathOrUrl, BASE_URL).hostname);
  } catch {
    return false;
  }
}
