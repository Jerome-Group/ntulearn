import { createHash } from "node:crypto";
import { attachmentName } from "../ntulearn/content.mjs";
import { attachmentPlacement, placedFile, placementsIn } from "../placement.mjs";
import { orderedName } from "../paths.mjs";
import { classifyRecordingCandidate } from "./classification.mjs";

const EMBED = /<(iframe|object|embed|video|audio|source)\b([^>]*)>/gi;
const LINK = /<a\b([^>]*)>/gi;
const ATTRIBUTE =
  /(?:^|\s)(src|href|data|type|data-bbfile)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;
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
    const placement = placements.get(item.id) ?? { trail: "", segments: [] };
    const candidates = [
      ...attachmentCandidates(attachmentsByItem.get(item.id) ?? []),
      ...bodyCandidates(item),
      ...externalCandidates(item),
    ];
    const seen = new Set();

    for (const candidate of candidates) {
      const classification =
        candidate.classification ?? classifyRecordingCandidate({ ...candidate, adapters });
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

  return collisionSafePlacements(recordings);
}

function collisionSafePlacements(recordings) {
  const groups = Map.groupBy(recordings, (recording) => recording.itemId);
  return recordings.map((recording) => {
    if (groups.get(recording.itemId).length === 1) return recording;
    const suffix = createHash("sha256").update(recording.recordingId).digest("hex").slice(0, 16);
    const placement = { ...recording.placement };
    for (const field of ["videoPath", "audioPath", "formattedTranscriptPath", "statusPath"]) {
      if (field === "videoPath" && placement.videoAlreadyPresent) continue;
      if (field === "audioPath" && placement.audioAlreadyPresent) continue;
      placement[field] = placement[field].replace(
        /(\.(?:transcript|media-status)\.md|\.[^/.]+)$/,
        ` (${suffix})$1`,
      );
    }
    return { ...recording, placement };
  });
}

function appearance({
  course,
  item,
  placement,
  provider,
  providerReference,
  identityReference,
  candidateReference,
  disposition,
  classificationEvidence,
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
    recordingId: `content-tree:${course.courseId}:${item.id}:${identityReference ?? providerReference}`,
    courseKey: course.key,
    courseId: course.courseId,
    itemId: item.id,
    title: item.title,
    position: item.position,
    trail: placement.trail,
    provider,
    providerReference,
    candidateReference,
    disposition,
    classificationEvidence,
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
  return attachments.map((attachment) => ({
    value: attachment,
    sourceKind: "attachment",
    attachment,
  }));
}

function bodyCandidates(item) {
  const candidates = [];
  const bodies = new Set([item.body?.rawText ?? "", item.body?.displayText ?? ""]);
  for (const html of bodies) {
    for (const [index, match] of [...html.matchAll(EMBED), ...html.matchAll(LINK)].entries()) {
      const isEmbed = match[0].match(/^<a\b/i) === null;
      const attributes = isEmbed ? match[2] : match[1];
      const fields = attributeFields(attributes);
      const values = attributeCandidates(fields);
      const embedded = embeddedValue(fields);
      const sourceKind = isEmbed ? "embedded-player" : "external-link";
      for (const value of values) candidates.push({ value, sourceKind });
      if (embedded.value) candidates.push({ value: embedded.value, sourceKind: "embedded-player" });
      if (
        embedded.malformed ||
        (isEmbed && values.length === 0 && !embedded.value && !hasChildSource(html, match))
      ) {
        candidates.push({
          value: { id: `unresolved-embed-${index + 1}` },
          sourceKind: "embedded-player",
        });
      }
    }
  }
  return candidates;
}

function externalCandidates(item) {
  const links = Object.entries(item.contentDetail ?? {}).flatMap(([key, detail]) =>
    detailLinks(detail, key),
  );
  const byValue = new Map();
  for (const link of links) {
    const address = typeof link.value === "string" ? link.value : (link.value.url ?? link.value.id);
    const previous = byValue.get(address);
    if (
      !previous ||
      (link.sourceKind === "launch-link" && previous.sourceKind === "external-link")
    ) {
      byValue.set(address, link);
    }
  }
  return [...byValue.values()];
}

function detailLinks(detail, detailKey) {
  const metadata = Object.fromEntries(
    ["mimeType", "contentType", "type", "fileName", "filename"].flatMap((key) =>
      typeof detail?.[key] === "string" ? [[key, detail[key]]] : [],
    ),
  );
  const links = [
    { value: detail?.url, sourceKind: "external-link" },
    { value: detail?.launchUrl, sourceKind: "launch-link" },
    { value: detail?.launchLink, sourceKind: "launch-link" },
    { value: detail?.placement?.launchLink, sourceKind: "launch-link" },
  ]
    .filter(({ value }) => typeof value === "string" && value.trim())
    .map((link) => ({
      ...link,
      value: Object.keys(metadata).length ? { ...metadata, url: link.value } : link.value,
    }));
  const mediaTyped = [metadata.mimeType, metadata.contentType, metadata.type].some((type) =>
    /^(?:video|audio)\//i.test(type ?? ""),
  );
  if (links.length || !mediaTyped) return links;
  const identity = createHash("sha256").update(detailKey).digest("hex").slice(0, 16);
  return [
    {
      value: { id: `unresolved-detail-${identity}` },
      sourceKind: "external-link",
      classification: {
        provider: "unsupported",
        providerReference: `unsupported:malformed-detail:${identity}`,
        candidateReference: `candidate:malformed-detail:${identity}`,
        disposition: "unresolved",
        classificationEvidence: "malformed",
        retryable: true,
        limitation:
          "Media-typed resource has no valid source address. Appearance unresolved. Inspect it in NTULearn and retry media discovery after metadata is clarified.",
      },
    },
  ];
}

function hasChildSource(html, match) {
  if (!/^(?:video|audio)$/i.test(match[1])) return false;
  const remainder = html.slice(match.index + match[0].length);
  const body = remainder.split(new RegExp(`</${match[1]}\\s*>`, "i"), 1)[0];
  return [...body.matchAll(EMBED)].some(
    (child) =>
      child[1].toLowerCase() === "source" &&
      attributeCandidates(attributeFields(child[2])).length > 0,
  );
}

function attributeFields(attributes) {
  return [...attributes.matchAll(ATTRIBUTE)].map((match) => [
    match[1].toLowerCase(),
    decodeHtmlEntities(match[2] ?? match[3] ?? match[4]),
  ]);
}

function attributeCandidates(fields) {
  const type = fields.find(([key]) => key === "type")?.[1];
  return fields
    .filter(([key]) => !["type", "data-bbfile"].includes(key))
    .map(([, url]) => (type ? { url, type } : url));
}

function embeddedValue(fields) {
  const encoded = fields.find(([key]) => key === "data-bbfile")?.[1];
  if (encoded === undefined) return { value: null, malformed: false };
  try {
    const value = JSON.parse(encoded);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value, malformed: false }
      : { value: null, malformed: true };
  } catch {
    return { value: null, malformed: true };
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
