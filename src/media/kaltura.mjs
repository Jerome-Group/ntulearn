import { absoluteUrl } from "../ntulearn/urls.mjs";
import { acquireRepresentation, chooseRepresentation } from "./acquisition.mjs";

export { chooseRepresentation };

const ENTRY_KEYS = ["entry_id", "entryId", "entryid", "kalturaEntryId"];
const ENTRY_PATH = /(?:^|[/:_-])entry[_-]?id[/:_-]([^/?#&]+)/i;
const KALTURA_HOST = /(?:^|\.)kaltura(?:\.|$)/i;
const KAF_HOST = /^kaf\./i;

export function kalturaReferenceOf(value) {
  if (value && typeof value === "object") {
    for (const key of ENTRY_KEYS) {
      const entryId = value[key];
      const reference = safeEntryReference(entryId);
      if (reference) return reference;
    }
    for (const key of ["resourceUrl", "viewerUrl", "url", "launchUrl", "launchLink"]) {
      const reference = kalturaReferenceOf(value[key]);
      if (reference) return reference;
    }
    return null;
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let parsed;
  try {
    parsed = new URL(absoluteUrl(text));
  } catch {
    return null;
  }

  for (const key of ENTRY_KEYS) {
    const entryId = parsed.searchParams.get(key);
    const reference = safeEntryReference(entryId);
    if (reference) return reference;
  }

  for (const value of parsed.searchParams.values()) {
    const nested = kalturaReferenceOf(decodeURIComponentSafe(value));
    if (nested) return nested;
  }

  const pathEntry = parsed.pathname.match(ENTRY_PATH)?.[1];
  const pathReference = safeEntryReference(pathEntry);
  if (pathReference) return pathReference;
  if (!isKalturaUrl(parsed)) return null;
  return `path:${parsed.hostname}${parsed.pathname}`;
}

export function isKalturaUrl(value) {
  if (!(value instanceof URL) && (typeof value !== "string" || !value.trim())) return false;
  try {
    const parsed = value instanceof URL ? value : new URL(absoluteUrl(value));
    return (
      KALTURA_HOST.test(parsed.hostname) ||
      KAF_HOST.test(parsed.hostname) ||
      /kaltura/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function createKalturaProvider({ resolveEntry, download, remux }) {
  if (typeof resolveEntry !== "function") throw new Error("Kaltura provider needs resolveEntry.");
  if (typeof download !== "function") throw new Error("Kaltura provider needs download.");
  if (typeof remux !== "function") throw new Error("Kaltura provider needs remux.");

  return {
    name: "kaltura",

    // Resolution is deliberately per-job. Kaltura playback and caption addresses may carry a
    // session-bound `ks`, so neither the source URL nor the resolved player response belongs in a
    // recording appearance, state file, or artifact metadata.
    resolve(appearance, { signal } = {}) {
      return resolveEntry({
        reference: appearance.providerReference,
        fresh: true,
        ...(signal ? { signal } : {}),
      });
    },

    transcript(resolved) {
      return resolved?.transcript ?? null;
    },

    async media(resolved, { signal } = {}) {
      const video = chooseRepresentation(resolved?.media?.video ?? []);
      if (video) {
        return acquireRepresentation({
          representation: video,
          kind: "video",
          download,
          remux,
          provider: "Kaltura",
          signal,
        });
      }

      const audio = chooseRepresentation(resolved?.media?.audio ?? [], 0);
      if (audio) {
        return acquireRepresentation({
          representation: audio,
          kind: "audio",
          download,
          remux,
          provider: "Kaltura",
          signal,
        });
      }

      return {
        kind: "unavailable",
        limitation: "Kaltura exposed no downloadable video or audio representation.",
        retryable: true,
      };
    },
  };
}

function safeEntryReference(value) {
  if (!isReference(value)) return null;
  const safe = String(value)
    .trim()
    .split(/[?#&\s]/, 1)[0]
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return safe ? `entry:${safe}` : null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isReference(value) {
  return typeof value === "string" && value.trim().length > 0;
}
