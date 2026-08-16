import { absoluteUrl } from "../ntulearn/urls.mjs";
import {
  acquireRepresentation,
  acquireWithAudioFallback,
  chooseRepresentation,
} from "./acquisition.mjs";

const URL_KEYS = ["resourceUrl", "viewerUrl", "url", "href", "src", "launchUrl", "launchLink"];
const NAME_KEYS = ["fileName", "linkName", "displayName", "filename", "name"];
const VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpd",
  ".mpeg",
  ".mpg",
  ".m3u8",
  ".ogv",
  ".webm",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".wav",
  ".weba",
]);

export function directMediaKindOf(value) {
  if (value && typeof value === "object") {
    for (const key of ["mimeType", "contentType", "type"]) {
      const kind = kindFromMime(value[key]);
      if (kind) return kind;
    }
    for (const key of [...NAME_KEYS, ...URL_KEYS]) {
      const kind = directMediaKindOf(value[key]);
      if (kind) return kind;
    }
    return null;
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const extension = extensionOf(value);
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

export function directMediaReferenceOf(value) {
  const kind = directMediaKindOf(value);
  if (!kind) return null;

  const address = addressOf(value);
  if (!address) {
    const name = nameOf(value);
    return name ? `direct:file:${safeIdentity(name)}` : null;
  }

  try {
    const parsed = new URL(absoluteUrl(address));
    const identity = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    return identity ? `direct:${safeIdentity(identity)}` : null;
  } catch {
    return null;
  }
}

export function createDirectProvider({ resolveMedia, download, remux }) {
  if (typeof resolveMedia !== "function") throw new Error("Direct provider needs resolveMedia.");
  if (typeof download !== "function") throw new Error("Direct provider needs download.");
  if (typeof remux !== "function") throw new Error("Direct provider needs remux.");

  return {
    name: "direct",

    resolve(appearance, { signal } = {}) {
      return resolveMedia({
        reference: appearance.providerReference,
        ...(appearance.mediaType ? { kind: appearance.mediaType } : {}),
        fresh: true,
        ...(signal ? { signal } : {}),
      });
    },

    transcript(resolved) {
      return resolved?.transcript ?? resolved?.providerTranscript ?? null;
    },

    async media(resolved, { signal } = {}) {
      const video = chooseRepresentation(videoRepresentations(resolved));
      const audio = chooseRepresentation(audioRepresentations(resolved), 0);
      if (video) {
        return acquireWithAudioFallback({
          video,
          audio,
          download,
          remux,
          provider: "Direct",
          signal,
        });
      }
      if (audio) {
        return acquireRepresentation({
          representation: audio,
          kind: "audio",
          download,
          remux,
          provider: "Direct",
          signal,
        });
      }

      const single = singleRepresentation(resolved);
      if (single) {
        return acquireRepresentation({
          representation: single,
          kind: single.kind,
          download,
          remux,
          provider: "Direct",
          signal,
        });
      }

      return {
        kind: "unavailable",
        limitation: "Direct recording exposed no downloadable video or audio representation.",
        retryable: true,
      };
    },
  };
}

function videoRepresentations(resolved) {
  return asList(resolved?.media?.video ?? resolved?.video ?? formatsOf(resolved, "video"));
}

function audioRepresentations(resolved) {
  return asList(resolved?.media?.audio ?? resolved?.audio ?? formatsOf(resolved, "audio"));
}

function formatsOf(resolved, kind) {
  return (resolved?.formats ?? []).filter((format) => directMediaKindOf(format) === kind);
}

function singleRepresentation(resolved) {
  const kind = directMediaKindOf(resolved) ?? resolved?.kind;
  if ((kind !== "video" && kind !== "audio") || typeof resolved?.url !== "string") return null;
  return { ...resolved, height: resolved.height ?? null };
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function addressOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return URL_KEYS.map((key) => value[key]).find(
    (candidate) => typeof candidate === "string" && candidate,
  );
}

function nameOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return NAME_KEYS.map((key) => value[key]).find(
    (candidate) => typeof candidate === "string" && candidate,
  );
}

function extensionOf(value) {
  const address = addressOf(value) ?? value;
  try {
    const pathname = new URL(absoluteUrl(address)).pathname;
    return pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  } catch {
    const name = String(address).split(/[?#]/, 1)[0];
    return name.slice(name.lastIndexOf(".")).toLowerCase();
  }
}

function kindFromMime(value) {
  if (typeof value !== "string") return null;
  if (/^video\//i.test(value)) return "video";
  if (/^audio\//i.test(value)) return "audio";
  return null;
}

function safeIdentity(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._/-]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}
