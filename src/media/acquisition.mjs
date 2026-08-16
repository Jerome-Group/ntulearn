import { Buffer } from "node:buffer";
import { publicMediaError } from "./errors.mjs";

export function chooseRepresentation(representations, preferredHeight = 720) {
  const usable = (representations ?? [])
    .filter((representation) => isReference(representation?.url))
    .map((representation) => ({
      ...representation,
      height: numberOrNull(representation.height ?? representation.videoHeight),
    }));
  if (!usable.length) return null;

  return (
    usable.find(({ height }) => height === preferredHeight) ??
    highestAtOrBelow(usable, preferredHeight) ??
    lowestAbove(usable, preferredHeight) ??
    usable[0]
  );
}

export async function acquireRepresentation({ representation, kind, download, remux, provider }) {
  const downloaded = await download(representation.url, { fresh: true });
  const remuxed = await remux(downloaded, {
    representation,
    reencode: false,
  });
  const body = Buffer.isBuffer(remuxed) ? remuxed : remuxed?.body;
  if (!Buffer.isBuffer(body)) throw new Error(`${provider} ${kind} remux did not return bytes.`);

  return {
    kind,
    body,
    filename:
      remuxed?.filename ??
      representation.filename ??
      `${representation.id ?? kind}.${kind === "audio" ? "m4a" : "mp4"}`,
    quality: representation.height,
    audio: kind === "audio" || (remuxed?.audio !== false && representation.audio !== false),
  };
}

export async function acquireWithAudioFallback({ video, audio, download, remux, provider }) {
  try {
    return await acquireRepresentation({
      representation: video,
      kind: "video",
      download,
      remux,
      provider,
    });
  } catch (videoError) {
    if (!audio) {
      return {
        kind: "unavailable",
        limitation: `${provider} video acquisition failed: ${publicMediaError(videoError)}`,
        retryable: true,
      };
    }
    try {
      const retained = await acquireRepresentation({
        representation: audio,
        kind: "audio",
        download,
        remux,
        provider,
      });
      return {
        ...retained,
        retryable: true,
        limitation: `${provider} video acquisition failed: ${publicMediaError(videoError)}; retained audio-only media.`,
      };
    } catch (audioError) {
      return {
        kind: "unavailable",
        limitation:
          `${provider} video acquisition failed: ${publicMediaError(videoError)}. ` +
          `${provider} audio acquisition failed: ${publicMediaError(audioError)}`,
        retryable: true,
      };
    }
  }
}

function highestAtOrBelow(representations, height) {
  return representations
    .filter(({ height: candidate }) => candidate !== null && candidate <= height)
    .sort((left, right) => right.height - left.height)[0];
}

function lowestAbove(representations, height) {
  return representations
    .filter(({ height: candidate }) => candidate !== null && candidate > height)
    .sort((left, right) => left.height - right.height)[0];
}

function isReference(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
