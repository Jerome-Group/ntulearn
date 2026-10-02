import { isIdentityProviderUrl } from "./urls.mjs";

const SIGN_IN_AGAIN = "Run: npm run login";

export function signInStalled(url, timeoutMs) {
  const seconds = timeoutMs / 1000;
  const address = diagnosticAddress(url);
  if (isIdentityProviderUrl(url)) {
    return `NTULearn sign-in is still at the identity provider after ${seconds}s: ${address}. ${SIGN_IN_AGAIN}`;
  }
  return `NTULearn did not answer within ${seconds}s; sign-in stopped at ${address}. Run the command again, and if it keeps happening: ${SIGN_IN_AGAIN}`;
}

export function diagnosticAddress(url) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return "an unknown address";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "an unknown address";
  }
}
