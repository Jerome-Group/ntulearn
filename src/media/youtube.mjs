import { absoluteUrl } from "../ntulearn/urls.mjs";
import { directMediaKindOf } from "./direct.mjs";
import {
  acquireRepresentation,
  acquireWithAudioFallback,
  chooseRepresentation,
} from "./acquisition.mjs";

const YOUTUBE_HOSTS = new Set([
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "youtube.com",
  "youtu.be",
]);
const URL_KEYS = ["url", "href", "src", "viewerUrl", "launchUrl", "launchLink"];

export function isYoutubeUrl(value) {
  try {
    const parsed = new URL(absoluteUrl(value));
    return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function youtubeReferenceOf(value) {
  if (value && typeof value === "object") {
    for (const key of ["youtubeId", "videoId", "video_id"]) {
      const reference = safeVideoReference(value[key]);
      if (reference) return reference;
    }
    for (const key of URL_KEYS) {
      const reference = youtubeReferenceOf(value[key]);
      if (reference) return reference;
    }
    return null;
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (text.startsWith("youtube:")) return safeVideoReference(text.slice("youtube:".length));
  if (!isYoutubeUrl(text)) return null;

  let parsed;
  try {
    parsed = new URL(absoluteUrl(text));
  } catch {
    return null;
  }
  const path = parsed.pathname.split("/").filter(Boolean);
  const candidate =
    parsed.hostname === "youtu.be"
      ? path[0]
      : parsed.pathname === "/watch"
        ? parsed.searchParams.get("v")
        : ["embed", "live", "shorts", "v"].includes(path[0])
          ? path[1]
          : null;
  return safeVideoReference(candidate);
}

export function createYoutubeProvider({
  resolveVideo,
  download,
  remux,
  fetchTranscript = download,
}) {
  if (typeof resolveVideo !== "function") throw new Error("YouTube provider needs resolveVideo.");
  if (typeof download !== "function") throw new Error("YouTube provider needs download.");
  if (typeof remux !== "function") throw new Error("YouTube provider needs remux.");

  return {
    name: "youtube",

    resolve(appearance, { signal } = {}) {
      return resolveVideo({
        reference: appearance.providerReference,
        fresh: true,
        ...(signal ? { signal } : {}),
      });
    },

    async transcript(resolved, { signal } = {}) {
      const transcript =
        resolved?.transcript ?? resolved?.providerTranscript ?? selectCaption(resolved);
      if (!transcript) return null;
      const fetched = await fetchCaptionBody(transcript, fetchTranscript, signal);
      if (fetched) return fetched;
      if (typeof transcript === "string") {
        return {
          body: transcript,
          language: resolved?.language ?? "und",
          filename: "captions.vtt",
        };
      }
      return {
        ...transcript,
        language: transcript.language ?? resolved?.language ?? "und",
      };
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
          provider: "YouTube",
          signal,
        });
      }
      if (audio) {
        return acquireRepresentation({
          representation: audio,
          kind: "audio",
          download,
          remux,
          provider: "YouTube",
          signal,
        });
      }

      return {
        kind: "unavailable",
        limitation: "YouTube exposed no downloadable video or audio representation.",
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
  return (resolved?.formats ?? []).filter(
    (format) => format?.kind === kind || directMediaKindOf(format) === kind,
  );
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function selectCaption(resolved) {
  const captions = resolved?.captions ?? resolved?.captionTracks;
  if (Array.isArray(captions)) {
    return captions.find((caption) => caption.default || caption.isDefault) ?? captions[0] ?? null;
  }
  return resolved?.caption ?? captions ?? null;
}

async function fetchCaptionBody(transcript, fetchTranscript, signal) {
  if (!transcript || typeof transcript !== "object" || !fetchTranscript) return null;
  if (transcript.body !== undefined || transcript.content !== undefined || transcript.segments) {
    return null;
  }
  const address = transcript.url ?? transcript.baseUrl;
  if (typeof address !== "string" || !address) return null;
  const fetched = await fetchTranscript(address, {
    fresh: true,
    ...(signal ? { signal } : {}),
  });
  const body = fetched?.body ?? fetched?.content ?? fetched;
  if (body === undefined || body === null)
    throw new Error("YouTube caption fetch returned no body.");
  return {
    ...transcript,
    body,
    filename: transcript.filename ?? "captions.vtt",
  };
}

function safeVideoReference(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const safe = value.trim().split(/[?#&\s]/, 1)[0];
  return /^[A-Za-z0-9_-]{3,128}$/.test(safe) ? `youtube:${safe}` : null;
}
