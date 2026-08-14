const BASE_URL = "https://ntulearn.ntu.edu.sg";
const IDENTITY_PROVIDERS = new Set(["login.microsoftonline.com", "idp.ntu.edu.sg"]);
const SIGN_IN_PATHS = ["/webapps/login", "/auth-saml/"];

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

// Where a request lands when the session behind it has lapsed. The round trip to NTU's identity
// provider is only its far end: NTULearn hands a request off from its own sign-in paths, and a
// session that lapses while a request is in flight can be answered from either place. Both mean
// the same thing to a reader — sign in again — so both count.
export function isSignInUrl(pathOrUrl) {
  if (isIdentityProviderUrl(pathOrUrl)) return true;
  try {
    const { pathname } = new URL(pathOrUrl, BASE_URL);
    return SIGN_IN_PATHS.some((path) => pathname.startsWith(path));
  } catch {
    return false;
  }
}
