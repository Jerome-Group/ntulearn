import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function attachmentState(previous, source, attachment) {
  const key = "identity:" + source.identity;
  const candidate =
    previous.downloads?.[key] ??
    previous.downloads?.[attachmentUrlKey(attachment)] ??
    previous.downloads?.[attachment.resourceUrl];
  const identityConflict =
    candidate?.sourceIdentity != null && candidate.sourceIdentity !== source.identity;
  return { key, record: identityConflict ? null : candidate, identityConflict };
}

export function attachmentFingerprint(item, attachment, { legacy = false } = {}) {
  if (legacy)
    return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
  return hash(
    JSON.stringify([
      item.modifiedDate ?? null,
      attachment.fileSize ?? null,
      attachmentUrlKey(attachment),
    ]),
  );
}

function attachmentUrlKey(attachment) {
  const address = String(attachment.resourceUrl ?? "");
  let secret = /[?#]|\/(?:ks|%6bs|k%73|%6b%73|session|token)\//i.test(address);
  try {
    const url = new URL(address, "https://ntulearn.ntu.edu.sg");
    secret ||= Boolean(url.username || url.password);
  } catch {}
  return secret ? "source:" + hash(address) : address;
}
