import { attachmentName, isFolder } from "../ntulearn/content.mjs";
import { attachmentPlacement, placedFile, placementsIn } from "../placement.mjs";
import { orderedName } from "../paths.mjs";
import { classifyRecordingCandidate } from "./classification.mjs";

const EMBED = /<(iframe|object|embed|video|audio|source)\b([^>]*)>/gi;
const LINK = /<a\b([^>]*)>/gi;
const ATTRIBUTE = /\b(src|href|data)\s*=\s*(["'])(.*?)\2/gi;
const JSON_ATTRIBUTE = /\bdata-bbfile\s*=\s*(["'])(.*?)\1/i;
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".m4a", ".mp3", ".ogg", ".wav"]);

export function discoverContentRecordings({
  course,
  snapshot,
  attachmentsByItem = new Map(),
  adapters,
}) {
  const placements = placementsIn(snapshot.items ?? []);
  const recordings = [];

  for (const item of snapshot.items ?? []) {
    if (isFolder(item)) continue;

    const placement = placements.get(item.id) ?? { trail: "", segments: [] };
    const candidates = [
      ...attachmentCandidates(attachmentsByItem.get(item.id) ?? []),
      ...bodyCandidates(item),
      ...externalCandidates(item),
    ];
    const seen = new Set();

    for (const candidate of candidates) {
      const classification = classifyRecordingCandidate({ ...candidate, adapters });
      if (!classification) continue;
      const identity = `${classification.provider}:${classification.providerReference}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      recordings.push(
        appearance({
          course,
          item,
          placement,
          ...classification,
          sourceKind: candidate.sourceKind,
          attachment: candidate.attachment,
        }),
      );
    }
  }

  return recordings;
}

function appearance({
  course,
  item,
  placement,
  provider,
  providerReference,
  mediaType,
  providerName,
  providerShape,
  retryable,
  limitation,
  sourceKind,
  attachment,
}) {
  const target = mediaPlacement({ course, item, placement, attachment });
  return {
    recordingId: `content-tree:${course.courseId}:${item.id}:${providerReference}`,
    courseKey: course.key,
    courseId: course.courseId,
    itemId: item.id,
    title: item.title,
    position: item.position,
    trail: placement.trail,
    provider,
    providerReference,
    mediaType: mediaType ?? null,
    ...(providerName ? { providerName } : {}),
    ...(providerShape ? { providerShape } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(limitation ? { limitation } : {}),
    sourceKind,
    storageSurface: "content-tree",
    placement: target,
  };
}

function mediaPlacement({ course, item, placement, attachment }) {
  const itemName = orderedName(item.position, item.title);
  const itemFile = placedFile(placement, itemName, `${item.title}.md`);
  const attachedMedia = isVideoOrAudio(attachment)
    ? attachmentPlacement(placement, item, attachment)
    : null;
  const stem = attachedMedia
    ? withoutExtension(attachedMedia.path)
    : withoutExtension(itemFile.path);
  const directory = placement.segments.join("/");

  return {
    destination: course.destination,
    directorySegments: [...placement.segments],
    trail: placement.trail,
    linkPath: itemFile.path,
    videoPath: isVideo(attachment) ? attachedMedia.path : `${stem}.mp4`,
    videoAlreadyPresent: isVideo(attachment),
    audioPath: isAudio(attachment) ? attachedMedia.path : `${stem}.m4a`,
    audioAlreadyPresent: isAudio(attachment),
    formattedTranscriptPath: `${stem}.transcript.md`,
    statusPath: `${stem}.media-status.md`,
    directory,
  };
}

function attachmentCandidates(attachments) {
  return attachments.flatMap((attachment) => [
    { value: attachment, sourceKind: "attachment", attachment },
    ...["resourceUrl", "viewerUrl", "url", "launchUrl", "launchLink", "entryId", "entry_id"]
      .filter((key) => attachment?.[key] != null)
      .map((key) => ({ value: attachment[key], sourceKind: "attachment", attachment })),
  ]);
}

function bodyCandidates(item) {
  const html = `${item.body?.rawText ?? ""}\n${item.body?.displayText ?? ""}`;
  const candidates = [];

  for (const match of html.matchAll(EMBED)) {
    const attributes = match[2];
    for (const value of attributeValues(attributes)) {
      candidates.push({ value, sourceKind: "embedded-player" });
    }
    const embedded = embeddedValue(attributes);
    if (embedded) candidates.push({ value: embedded, sourceKind: "embedded-player" });
  }

  for (const match of html.matchAll(LINK)) {
    const attributes = match[1];
    for (const value of attributeValues(attributes)) {
      candidates.push({ value, sourceKind: "external-link" });
    }
    const embedded = embeddedValue(attributes);
    if (embedded) candidates.push({ value: embedded, sourceKind: "embedded-player" });
  }

  return candidates;
}

function externalCandidates(item) {
  const links = Object.values(item.contentDetail ?? {}).flatMap((detail) =>
    detailLinks(detail).map(({ value, sourceKind }) => ({ value, sourceKind })),
  );
  const byValue = new Map();
  for (const link of links) {
    const previous = byValue.get(link.value);
    if (
      !previous ||
      (link.sourceKind === "launch-link" && previous.sourceKind === "external-link")
    ) {
      byValue.set(link.value, link);
    }
  }
  return [...byValue.values()];
}

function detailLinks(detail) {
  return [
    { value: detail?.url, sourceKind: "external-link" },
    { value: detail?.launchUrl, sourceKind: "launch-link" },
    { value: detail?.launchLink, sourceKind: "launch-link" },
    { value: detail?.placement?.launchLink, sourceKind: "launch-link" },
  ].filter(({ value }) => typeof value === "string" && value);
}

function attributeValues(attributes) {
  return [...attributes.matchAll(ATTRIBUTE)].map((match) => match[3]);
}

function embeddedValue(attributes) {
  const encoded = attributes.match(JSON_ATTRIBUTE)?.[2];
  if (!encoded) return null;
  try {
    return JSON.parse(decodeHtmlEntities(encoded));
  } catch {
    return null;
  }
}

function isVideoOrAudio(attachment) {
  return isVideo(attachment) || isAudio(attachment);
}

function isVideo(attachment) {
  if (!attachment) return false;
  if (/^video\//i.test(attachment.mimeType ?? "")) return true;
  const name = attachmentName({ title: "" }, attachment).toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  return VIDEO_EXTENSIONS.has(extension);
}

function isAudio(attachment) {
  if (!attachment) return false;
  if (/^audio\//i.test(attachment.mimeType ?? "")) return true;
  const name = attachmentName({ title: "" }, attachment).toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  return AUDIO_EXTENSIONS.has(extension);
}

function withoutExtension(path) {
  return path.replace(/\.[^/.]+$/, "");
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
