import assert from "node:assert/strict";
import test from "node:test";
import { discoverMediaGallery } from "../src/media/gallery.mjs";

const COURSE = {
  key: "MH1101",
  courseId: "_9_1",
  destination: "/courses/MH1101/NTULearn",
  mediaMode: "pilot",
};

test("preserves gallery order, duplicate appearances, and collision-safe placements", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 3,
        entries: [
          galleryEntry("gallery-1", "entry:shared", "Topic / One", "2026-08-10T09:00:00+08:00"),
          galleryEntry("gallery-2", "entry:shared", "Topic / One", "2026-08-10T09:00:00+08:00"),
        ],
        hasMore: true,
      },
      {
        displayedCount: 3,
        entries: [
          galleryEntry("gallery-3", "entry:third", "Topic Three", "2026-08-10T10:00:00+08:00"),
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.verdict, "green");
  assert.deepEqual(result.queue, result.recordings);
  assert.deepEqual(
    result.recordings.map(({ providerReference, galleryIndex }) => [
      providerReference,
      galleryIndex,
    ]),
    [
      ["entry:shared", 0],
      ["entry:shared", 1],
      ["entry:third", 2],
    ],
  );
  assert.equal(
    result.recordings[0].placement.formattedTranscriptPath,
    "Media Gallery/2026-08-10 09-00-00 Topic _ One.transcript.md",
  );
  assert.equal(
    result.recordings[1].placement.formattedTranscriptPath,
    "Media Gallery/2026-08-10 09-00-00 Topic _ One (2).transcript.md",
  );
  assert.equal(
    result.recordings[0].placement.videoPath,
    "Media Gallery/2026-08-10 09-00-00 Topic _ One.mp4",
  );
  assert.equal(result.recordings[0].storageSurface, "media-gallery");
});

test("reconciles cumulative Load More snapshots without losing a true duplicate", () => {
  const first = galleryEntry("gallery-1", "entry:shared", "One", "2026-08-10T09:00:00+08:00");
  const second = galleryEntry("gallery-2", "entry:shared", "Two", "2026-08-10T10:00:00+08:00");
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      { displayedCount: 2, entries: [first], hasMore: true },
      { displayedCount: 2, entries: [first, second], hasMore: false },
    ],
  });

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.recordings.map(({ galleryEntryId, providerReference }) => [
      galleryEntryId,
      providerReference,
    ]),
    [
      ["gallery-1", "entry:shared"],
      ["gallery-2", "entry:shared"],
    ],
  );
});

test("keeps repeated appearances on replacing pages", () => {
  const entry = galleryEntry("gallery-1", "entry:shared", "One", "2026-08-10T09:00:00+08:00");
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      { displayedCount: 2, entries: [entry], hasMore: true, paginationMode: "append" },
      { displayedCount: 2, entries: [entry], hasMore: false, paginationMode: "replace" },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.discoveredCount, 2);
  assert.notEqual(result.recordings[0].recordingId, result.recordings[1].recordingId);
});

test("turns stable Media Gallery links into safe Kaltura references", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [
          {
            id: "https://ntulearn.ntu.edu.sg/media/t/entry-one?ks=secret",
            title: "Lecture",
            createdAt: "2026-08-10T09:00:00+08:00",
            visible: true,
            published: true,
          },
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(
    result.recordings[0].providerReference,
    "path:ntulearn.ntu.edu.sg/media/t/entry-one",
  );
  assert.doesNotMatch(JSON.stringify(result), /secret|https?:\/\//);
});

test("strips session material from already-normalized gallery references", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [
          galleryEntry(
            "gallery-1",
            "entry:entry-one?ks=secret",
            "Lecture",
            "2026-08-10T09:00:00+08:00",
          ),
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.recordings[0].providerReference, "entry:entry-one");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("normalizes a raw gallery entry id without treating the appearance id as provider data", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [
          {
            id: "gallery-1",
            entryId: "entry-one",
            title: "Lecture",
            createdAt: "2026-08-10T09:00:00+08:00",
            visible: true,
            published: true,
          },
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.recordings[0].providerReference, "entry:entry-one");
});

test("does not persist a zero duration when the Gallery omits duration metadata", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [galleryEntry("gallery-1", "entry:one", "Lecture", "2026-08-10T09:00:00+08:00")],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.recordings[0].duration, null);
});

test("does not queue a subset when the gallery count does not reconcile", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 3,
        entries: [galleryEntry("gallery-1", "entry:one", "One", "2026-08-10T09:00:00+08:00")],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.deepEqual(result.recordings, []);
  assert.match(result.limitation, /displayed 3.*discovered 1/i);
});

test("fails closed on an unsupported gallery entry shape", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [
          {
            id: "gallery-1",
            title: "No provider reference",
            createdAt: "2026-08-10T09:00:00+08:00",
          },
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.deepEqual(result.recordings, []);
  assert.match(result.limitation, /unsupported/i);
});

test("fails closed on a null gallery entry", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [{ displayedCount: 1, entries: [null], hasMore: false }],
  });

  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.deepEqual(result.queue, []);
  assert.match(result.limitation, /unsupported/i);
});

test("fails closed when a visible entry has no publication evidence", () => {
  const result = discoverMediaGallery({
    course: COURSE,
    pages: [
      {
        displayedCount: 1,
        entries: [
          {
            id: "gallery-1",
            providerReference: "entry:one",
            title: "Lecture",
            createdAt: "2026-08-10T09:00:00+08:00",
            visible: true,
          },
        ],
        hasMore: false,
      },
    ],
  });

  assert.equal(result.complete, false);
  assert.equal(result.verdict, "red");
  assert.deepEqual(result.queue, []);
  assert.match(result.limitation, /published recording evidence/i);
});

test("leaves off courses untouched", () => {
  const result = discoverMediaGallery({
    course: { ...COURSE, mediaMode: "off" },
    pages: null,
  });

  assert.deepEqual(result, {
    complete: true,
    skipped: true,
    verdict: "green",
    recordings: [],
    queue: [],
    displayedCount: 0,
    discoveredCount: 0,
    limitations: [],
    limitation: null,
  });
});

function galleryEntry(id, providerReference, title, createdAt) {
  return {
    id,
    provider: "kaltura",
    providerReference,
    title,
    createdAt,
    visible: true,
    published: true,
  };
}
