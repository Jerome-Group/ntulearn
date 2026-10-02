const MAX_REFERENCE_LENGTH = 65_536;
const SESSION_COMPONENT = /(?:\/|%2f)(ks|%6bs|k%73|%6b%73)(?:\/|%2f)([^/?#&\s]+)/gi;
const RETAINED_SESSION_COMPONENT =
  /(?:\/|%2f)(ks|%6bs|k%73|%6b%73|_6bs|k_73|_6b_73)(?:\/|%2f)([^/?#&\s]+)/gi;

export function sessionPath(reference, { retained = false } = {}) {
  const value = String(reference ?? "");
  if (value.length > MAX_REFERENCE_LENGTH) {
    return { value: "reference-inspection-bound", uncertain: true, sessionBearing: false };
  }
  const authority = value.match(/^(?:https?:)?\/\/[^/?#\s]+/i)?.[0] ?? "";
  const rest = value.slice(authority.length);
  const end = rest.search(/[?#]/);
  const path = end === -1 ? rest : rest.slice(0, end);
  const suffix = end === -1 ? "" : rest.slice(end);
  let sessionBearing = false;
  const redacted = path.replace(retained ? RETAINED_SESSION_COMPONENT : SESSION_COMPONENT, () => {
    sessionBearing = true;
    return "/ks/session-redacted";
  });
  return { value: authority + redacted + suffix, uncertain: false, sessionBearing };
}
