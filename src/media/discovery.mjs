import { attachmentName, externalLinkOf, isFolder } from "../ntulearn/content.mjs";
import { kalturaReferenceOf } from "./kaltura.mjs";

const EMBED = /<(iframe|object|embed)\b([^>]*)>/gi;
const LINK = /<a\b([^>]*)>/gi;
const ATTRIBUTE = /\b(src|href|data)\s*=\s*(["'])(.*?)\2/gi;
const JSON_ATTRIBUTE = /\bdata-bbfile\s*=\s*(["'])(.*?)\1/i;
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".m4a", ".mp3", ".ogg", ".wav"]);
// eslint-disable-next-line no-control-regex -- control characters are what this strips
const RESERVED_CHARACTERS = /[\\/:*?"<>|\x00-\x1F]/g;

export function discoverContentRecordings({ course, snapshot, attachmentsByItem = new Map() }) {
  const placements = placementsIn(snapshot.items ?? []);
  const recordings = [];

  for (const item of snapshot.items ?? []) {
    if (isFolder(item)) continue;

    const placement = placements.get(item.id) ?? { trail: "", segments: [] };
    const candidates = [
      ...attachmentCandidates(attachmentsByItem.get(item.id) ?? []),
      ...bodyCandidates(item),
      ...externalCandidate(item),
    ];
    const seen = new Set();

    for (const candidate of candidates) {
      const providerReference = kalturaReferenceOf(candidate.value);
      if (!providerReference || seen.has(providerReference)) continue;
      seen.add(providerReference);
      recordings.push(
        appearance({
          course,
          item,
          placement,
          providerReference,
          sourceKind: candidate.sourceKind,
          attachment: candidate.attachment,
        }),
      );
    }
  }

  return recordings;
}

function appearance({ course, item, placement, providerReference, sourceKind, attachment }) {
  const target = mediaPlacement({ course, item, placement, attachment });
  return {
    recordingId: `content-tree:${course.courseId}:${item.id}:${providerReference}`,
    courseKey: course.key,
    courseId: course.courseId,
    itemId: item.id,
    title: item.title,
    position: item.position,
    trail: placement.trail,
    provider: "kaltura",
    providerReference,
    sourceKind,
    storageSurface: "content-tree",
    placement: target,
  };
}

function mediaPlacement({ course, item, placement, attachment }) {
  const itemName = orderedName(item.position, item.title);
  const itemFile = placedFile(placement, itemName, `${item.title}.md`);
  const attachedVideo = isVideoOrAudio(attachment)
    ? attachmentPlacement(placement, item, attachment)
    : null;
  const stem = attachedVideo
    ? withoutExtension(attachedVideo.path)
    : withoutExtension(itemFile.path);
  const directory = placement.segments.join("/");

  return {
    destination: course.destination,
    directorySegments: [...placement.segments],
    trail: placement.trail,
    linkPath: itemFile.path,
    videoPath: attachedVideo?.path ?? `${stem}.mp4`,
    videoAlreadyPresent: attachedVideo !== null,
    formattedTranscriptPath: `${stem}.transcript.md`,
    statusPath: `${stem}.media-status.md`,
    directory,
  };
}

function placementsIn(items) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return new Map(items.map((item) => [item.id, placementOf(item, itemsById)]));
}

function placementOf(item, itemsById) {
  const folders = [];
  for (let each = item; each; each = itemsById.get(each.parentId)) {
    if (isFolder(each)) folders.unshift(each);
  }
  return {
    trail: folders.map((folder) => folder.title).join(" › "),
    segments: folders.map((folder) => orderedName(folder.position, folder.title)),
  };
}

function attachmentPlacement(placement, item, attachment) {
  const file = attachmentName(item, attachment);
  return placedFile(placement, orderedName(item.position, file), file);
}

function placedFile(placement, name, file = name) {
  const segments = [...placement.segments, name];
  return { file, trail: placement.trail, segments, path: segments.join("/") };
}

function orderedName(position, name) {
  return `${String((position ?? 0) + 1).padStart(2, "0")} ${safeSegment(name)}`;
}

function safeSegment(value) {
  return (
    String(value ?? "")
      .normalize("NFKC")
      .replace(RESERVED_CHARACTERS, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") || "untitled"
  );
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

function externalCandidate(item) {
  const link = externalLinkOf(item);
  if (!link) return [];
  return [
    {
      value: link,
      sourceKind: isLaunchLink(item) ? "launch-link" : "external-link",
    },
  ];
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

function isLaunchLink(item) {
  return Object.values(item.contentDetail ?? {}).some(
    (detail) => detail?.launchUrl || detail?.launchLink || detail?.placement?.launchLink,
  );
}

function isVideoOrAudio(attachment) {
  if (!attachment) return false;
  if (/^(?:audio|video)\//i.test(attachment.mimeType ?? "")) return true;
  const name = attachmentName({ title: "" }, attachment).toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  return VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension);
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
