export const GLOBAL_MEDIA_ERROR_CODES = Object.freeze([
  "MEDIA_GLOBAL_SAFETY",
  "EACCES",
  "EIO",
  "ENODEV",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

export function publicMediaError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/https?:\/\/[^\s)]+/gi, "[provider address omitted]")
    .replace(/\b(ks|token|session|signature)=[^\s&]+/gi, "$1=[redacted]");
}

export function isGlobalMediaSafetyFailure(error) {
  if (!error) return false;
  if (error.globalSafety === true) return true;
  if (GLOBAL_MEDIA_ERROR_CODES.includes(error.code)) return true;
  return error.cause ? isGlobalMediaSafetyFailure(error.cause) : false;
}

export function markGlobalMediaSafety(error) {
  const marked = error instanceof Error ? error : new Error(publicMediaError(error));
  marked.globalSafety = true;
  return marked;
}
