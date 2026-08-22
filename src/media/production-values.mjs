import { resolve, sep } from "node:path";

export function directSourceFor(appearance) {
  const mediaType = appearance.mediaType === "audio" ? "audio" : "video";
  const placement = appearance.placement ?? {};
  const local =
    mediaType === "audio"
      ? placement.audioAlreadyPresent && placement.audioPath
      : placement.videoAlreadyPresent && placement.videoPath;
  if (local && placement.destination) {
    const destination = resolve(placement.destination);
    const path = resolve(destination, local);
    if (!path.startsWith(`${destination}${sep}`)) {
      throw new Error(
        `Direct media path escapes its course destination. Run: npm run media:discover -- ${appearance.courseKey ?? "<course>"}`,
      );
    }
    return { kind: mediaType, path, local: true };
  }
  const reference = String(appearance.providerReference ?? "").replace(/^direct:/, "");
  if (!reference || reference.startsWith("file:")) {
    throw new Error(
      "Direct media has no reconstructible source. Run: npm run media:discover -- " +
        (appearance.courseKey ?? "<course>"),
    );
  }
  return {
    kind: mediaType,
    address: reference.startsWith("http") ? reference : `https://${reference}`,
    local: false,
  };
}

export function mediaManifestUrl(bodies) {
  const urls = bodies
    .map((body) => body.replaceAll("\\/", "/").replaceAll("\\u0026", "&"))
    .flatMap((body) => [...body.matchAll(/https?:\/\/[^"'\s]+?\.m3u8(?:\?[^"'\s]*)?/gi)])
    .map(([url]) => url);
  return urls.find((url) => /index\.m3u8/i.test(url)) ?? urls[0] ?? null;
}

export function mediaTime(value) {
  if (typeof value === "number") return value > 100_000 ? value / 1000 : value;
  const text = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  if (!text || parts.some((part) => !Number.isFinite(part))) return NaN;
  const seconds = parts.pop();
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function transcriptSegmentTime(segment, offsetKey, fallbackKey) {
  const offset = segment.offsets?.[offsetKey];
  if (Number.isFinite(offset)) return offset / 1000;
  return mediaTime(segment.timestamps?.[offsetKey] ?? segment[fallbackKey]);
}

export function mediaExtension({ url, kind, contentType }) {
  const suffix = String(url ?? "").split(/[?#]/, 1)[0];
  const extension = suffix.slice(suffix.lastIndexOf(".")).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension;
  if (/audio\/mpeg/i.test(contentType)) return ".mp3";
  if (/audio\//i.test(contentType)) return ".m4a";
  return kind === "audio" ? ".m4a" : ".mp4";
}
