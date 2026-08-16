export function publicMediaError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/https?:\/\/[^\s)]+/gi, "[provider address omitted]")
    .replace(/\b(ks|token|session|signature)=[^\s&]+/gi, "$1=[redacted]");
}
