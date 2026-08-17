import { safeSegment } from "../paths.mjs";
import { absoluteUrl } from "../ntulearn/urls.mjs";
import { positiveDuration } from "./duration.mjs";
import { kalturaReferenceOf } from "./kaltura.mjs";

const HIDDEN_STATUSES = new Set(["hidden", "unpublished", "withdrawn"]);
const CREATION_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const MEDIA_GALLERY_PATH = /^\/media\/t(?:\/|$)/i;

export function discoverMediaGallery({ course, pages }) {
  if (!isMediaCourseEnabled(course)) return skippedGallery();

  const checkedPages = checkPages(pages);
  if (!checkedPages.valid) return incompleteGallery(checkedPages.reason);

  const visibleEntries = uniqueEntries(checkedPages.pages);
  const displayedCount = checkedPages.displayedCount;
  if (visibleEntries.length !== displayedCount) {
    return incompleteGallery(
      `Media Gallery count mismatch: displayed ${displayedCount}, discovered ${visibleEntries.length}.`,
      displayedCount,
      visibleEntries.length,
    );
  }

  const normalized = visibleEntries.map((entry, index) => normalizeEntry(entry, index));
  const unsupported = normalized.find(({ error }) => error);
  if (unsupported) {
    return incompleteGallery(
      `Media Gallery entry is unsupported: ${unsupported.error}.`,
      displayedCount,
      normalized.length,
    );
  }

  const recordings = placeEntries(
    course,
    normalized.map(({ value }) => value),
  );
  return {
    complete: true,
    verdict: "green",
    recordings,
    queue: recordings,
    displayedCount,
    discoveredCount: normalized.length,
    limitations: [],
    limitation: null,
  };
}

export function isMediaCourseEnabled(course) {
  return course?.mediaMode === "active" || course?.mediaMode === "pilot";
}

function checkPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { valid: false, reason: "Media Gallery was inaccessible or returned no pages." };
  }

  const displayedCounts = pages.map((page) => page?.displayedCount);
  if (displayedCounts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return { valid: false, reason: "Media Gallery did not expose a valid displayed total." };
  }
  if (new Set(displayedCounts).size !== 1) {
    return {
      valid: false,
      reason: "Media Gallery displayed total changed while it was being read.",
    };
  }
  if (pages.some((page) => !Array.isArray(page?.entries))) {
    return { valid: false, reason: "Media Gallery returned an unsupported page shape." };
  }
  if (pages.slice(0, -1).some((page) => page.hasMore !== true)) {
    return { valid: false, reason: "Media Gallery pagination stopped before the final page." };
  }
  if (pages.at(-1).hasMore === true) {
    return { valid: false, reason: "Media Gallery pagination was not exhausted." };
  }

  return { valid: true, pages, displayedCount: displayedCounts[0] };
}

function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { error: "unsupported entry shape" };
  }
  const provider = String(entry.provider ?? "kaltura").toLowerCase();
  if (provider !== "kaltura") return { error: `provider ${provider}` };
  if (entry.visible !== true) return { error: "missing visible recording evidence" };
  if (entry.published !== true) return { error: "missing published recording evidence" };

  const providerReference = galleryReference(entry);
  if (!providerReference) return { error: "missing Kaltura reference" };
  if (typeof entry.title !== "string" || !entry.title.trim()) {
    return { error: "missing title" };
  }
  const timestamp = creationTimestamp(entry.createdAt ?? entry.creationDate ?? entry.created);
  if (!timestamp) return { error: "missing provider creation date/time" };

  return {
    value: {
      ...entry,
      providerReference,
      title: entry.title.trim(),
      createdAt: timestamp,
      appearanceId: appearanceId(entry, providerReference, index),
    },
  };
}

function placeEntries(course, entries) {
  const collisions = new Map();
  return entries.map((entry, galleryIndex) => {
    const baseName = `${formatCreationTimestamp(entry.createdAt)} ${safeSegment(entry.title)}`;
    const occurrence = (collisions.get(baseName) ?? 0) + 1;
    collisions.set(baseName, occurrence);
    const stem = occurrence === 1 ? baseName : `${baseName} (${occurrence})`;
    const directory = "Media Gallery";

    return {
      recordingId: `media-gallery:${course.courseId}:${entry.appearanceId}`,
      courseKey: course.key,
      courseId: course.courseId,
      itemId: null,
      title: entry.title,
      position: galleryIndex,
      galleryIndex,
      galleryEntryId: entry.appearanceId,
      provider: "kaltura",
      providerReference: entry.providerReference,
      sourceKind: "media-gallery",
      storageSurface: "media-gallery",
      createdAt: entry.createdAt,
      mediaType: entry.mediaType ?? null,
      duration: positiveDuration(Number(entry.duration)),
      placement: {
        destination: course.destination,
        directorySegments: [directory],
        trail: directory,
        galleryOrder: galleryIndex,
        baseName: stem,
        videoPath: `${directory}/${stem}.mp4`,
        audioPath: `${directory}/${stem}.m4a`,
        formattedTranscriptPath: `${directory}/${stem}.transcript.md`,
        statusPath: `${directory}/${stem}.media-status.md`,
        videoAlreadyPresent: false,
        audioAlreadyPresent: false,
        directory,
      },
    };
  });
}

function galleryReference(entry) {
  const direct = entry.providerReference ?? entry.entryId ?? entry.entry_id;
  if (typeof direct === "string") {
    const normalized = direct.trim();
    if (normalized.startsWith("entry:")) {
      return kalturaReferenceOf({ entryId: normalized.slice("entry:".length) });
    }
    if (normalized.startsWith("path:")) {
      return normalized.split(/[?#&\s]/, 1)[0].replace(/[^A-Za-z0-9._:/-]/g, "_");
    }
    const reference = galleryReferenceOf(normalized);
    if (reference) return reference;
    if (/^[A-Za-z0-9._-]+$/.test(normalized)) {
      return kalturaReferenceOf({ entryId: normalized });
    }
  }
  return galleryReferenceOf(direct ?? entry.href ?? entry.url ?? entry.id ?? null);
}

function appearanceId(entry, providerReference, index) {
  return galleryIdentity(entry, providerReference, index).id;
}

function uniqueEntries(pages) {
  const seen = new Set();
  const occurrences = new Map();
  return pages.flatMap((page) => {
    const pageOccurrences = new Map();
    const paginationMode = page.paginationMode ?? "append";
    return page.entries.filter(isVisibleEntry).flatMap((entry) => {
      const identity = entryIdentity(entry);
      if (!identity) return [entry];

      const pageOccurrence = (pageOccurrences.get(identity) ?? 0) + 1;
      pageOccurrences.set(identity, pageOccurrence);
      const cumulativeRepeat =
        paginationMode !== "replace" && pageOccurrence === 1 && seen.has(identity);
      if (cumulativeRepeat) return [];

      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const candidate =
        occurrence === 1
          ? entry
          : {
              ...entry,
              appearanceId: `gallery-appearance:${safeIdentity(identity)}:${occurrence}`,
            };
      seen.add(identity);
      return [candidate];
    });
  });
}

function entryIdentity(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return galleryIdentity(entry, null, null).key;
}

function galleryIdentity(entry, providerReference, index) {
  const explicit = entry.appearanceId ?? entry.galleryEntryId ?? entry.id;
  const explicitReference = galleryReferenceOf(explicit ?? null);
  if (explicitReference) {
    return { id: safeIdentity(explicitReference), key: `reference:${explicitReference}` };
  }
  if (typeof explicit === "string" && explicit.trim()) {
    return { id: safeIdentity(explicit), key: `id:${explicit.trim()}` };
  }
  const linkReference = galleryReferenceOf(entry.href ?? entry.url ?? null);
  if (linkReference) return { id: safeIdentity(linkReference), key: `reference:${linkReference}` };
  if (providerReference && Number.isInteger(index)) {
    return { id: `${safeIdentity(providerReference)}-${index + 1}`, key: null };
  }
  return { id: null, key: null };
}

function galleryReferenceOf(value) {
  const mediaPath = mediaGalleryReference(value);
  return mediaPath ?? kalturaReferenceOf(value);
}

function mediaGalleryReference(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(absoluteUrl(value));
    return MEDIA_GALLERY_PATH.test(parsed.pathname)
      ? `path:${parsed.hostname}${parsed.pathname}`
      : null;
  } catch {
    return null;
  }
}

function safeIdentity(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
}

function isVisibleEntry(entry) {
  if (entry?.visible === false || entry?.published === false) return false;
  return !HIDDEN_STATUSES.has(String(entry?.status ?? "").toLowerCase());
}

function creationTimestamp(value) {
  if (typeof value === "string") {
    const match = value.trim().match(CREATION_TIME);
    if (!match || Number.isNaN(Date.parse(value))) return null;
    return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (Number.isFinite(value)) {
    const date = new Date(value < 10 ** 12 ? value * 1000 : value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function formatCreationTimestamp(value) {
  const match = value.match(CREATION_TIME);
  if (match) return `${match[1]} ${match[2]}-${match[3]}-${match[4] ?? "00"}`;
  return value
    .replace(/[:T]/g, "-")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}

function incompleteGallery(limitation, displayedCount = null, discoveredCount = 0) {
  return {
    complete: false,
    verdict: "red",
    recordings: [],
    queue: [],
    displayedCount,
    discoveredCount,
    limitations: [limitation],
    limitation,
  };
}

function skippedGallery() {
  return {
    complete: true,
    skipped: true,
    verdict: "green",
    recordings: [],
    queue: [],
    displayedCount: 0,
    discoveredCount: 0,
    limitations: [],
    limitation: null,
  };
}
