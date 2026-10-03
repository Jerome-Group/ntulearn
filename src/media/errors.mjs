export const GLOBAL_MEDIA_ERROR_CODES = Object.freeze([
  "MEDIA_GLOBAL_SAFETY",
  "MEDIA_PROCESS_CLEANUP",
  "MEDIA_BROWSER_CLEANUP",
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
    .replace(
      /\b(ks|access_token|id_token|launch_token|launch|token|session|signature|cookie|state|sig)=[^\s&]+/gi,
      "$1=[redacted]",
    );
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

export function unconfirmedMediaCleanupCode(error) {
  if (["MEDIA_PROCESS_CLEANUP", "MEDIA_BROWSER_CLEANUP"].includes(error?.code)) return error.code;
  return error?.cause ? unconfirmedMediaCleanupCode(error.cause) : null;
}
