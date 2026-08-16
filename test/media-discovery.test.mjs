import assert from "node:assert/strict";
import test from "node:test";
import { discoverContentRecordings } from "../src/media/discovery.mjs";

const KALTURA = "https://media.example.test/p/123/sp/12300/embedIframeJs/uiconf_id/7/entry_id/";

test("classifies each Kaltura content-tree appearance without persisting its expiring URL", () => {
  const course = {
    key: "MH2100",
    courseId: "_9_1",
    destination: "/courses/MH2100/NTULearn",
  };
  const snapshot = {
    items: [
      {
        id: "root",
        parentId: null,
        position: 0,
        title: "Lectures",
        contentHandler: "resource/x-bb-folder",
      },
      {
        id: "attachment-item",
        parentId: "root",
        position: 0,
        title: "Week 1",
        contentHandler: "resource/x-bb-file",
      },
      {
        id: "embedded-item",
        parentId: "root",
        position: 2,
        title: "Week 2",
        contentHandler: "resource/x-bb-document",
        body: {
          displayText: `<iframe src="${KALTURA}embedded?ks=secret-embedded"></iframe>`,
        },
      },
      {
        id: "external-item",
        parentId: "root",
        position: 4,
        title: "Week 3",
        contentHandler: "resource/x-bb-externallink",
        contentDetail: {
          "resource/x-bb-externallink": { url: `${KALTURA}external?ks=secret-external` },
        },
      },
      {
        id: "launch-item",
        parentId: "root",
        position: 6,
        title: "Week 4",
        contentHandler: "resource/x-bb-lti-launch",
        contentDetail: {
          "resource/x-bb-lti-launch": {
            placement: { launchLink: `${KALTURA}launch?ks=secret-launch` },
          },
        },
      },
      {
        id: "repeat-item",
        parentId: "root",
        position: 8,
        title: "Week 5",
        contentHandler: "resource/x-bb-document",
        body: { displayText: `<a href="${KALTURA}embedded?ks=secret-repeat">same entry</a>` },
      },
    ],
  };

  const recordings = discoverContentRecordings({
    course,
    snapshot,
    attachmentsByItem: new Map([
      [
        "attachment-item",
        [
          {
            fileName: "Week 1.mp4",
            mimeType: "video/mp4",
            resourceUrl: `${KALTURA}attachment?ks=secret-attachment`,
          },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    recordings.map(({ sourceKind }) => sourceKind),
    ["attachment", "embedded-player", "external-link", "launch-link", "external-link"],
  );
  assert.deepEqual(
    recordings.map(({ providerReference }) => providerReference),
    ["entry:attachment", "entry:embedded", "entry:external", "entry:launch", "entry:embedded"],
  );
  assert.equal(new Set(recordings.map(({ recordingId }) => recordingId)).size, recordings.length);
  assert.equal(recordings[0].placement.trail, "Lectures");
  assert.equal(recordings[0].placement.videoAlreadyPresent, true);
  assert.equal(recordings[0].placement.videoPath, "01 Lectures/01 Week 1.mp4");
  assert.equal(
    recordings[0].placement.formattedTranscriptPath,
    "01 Lectures/01 Week 1.transcript.md",
  );
  assert.equal(recordings[1].placement.videoPath, "01 Lectures/03 Week 2.mp4");

  const serialized = JSON.stringify(recordings);
  assert.doesNotMatch(serialized, /secret-/);
  assert.doesNotMatch(serialized, /https?:\/\//);
});

test("deduplicates repeated Kaltura surfaces inside one content item but not placements", () => {
  const item = {
    id: "item-1",
    parentId: null,
    position: 0,
    title: "Lecture",
    contentHandler: "resource/x-bb-document",
    body: {
      rawText: [
        `<a href="${KALTURA}shared?ks=one">one</a>`,
        `<iframe src="${KALTURA}shared?ks=two"></iframe>`,
      ].join("\n"),
    },
  };
  const course = { key: "MH2100", courseId: "_9_1", destination: "/courses/MH2100" };

  const recordings = discoverContentRecordings({
    course,
    snapshot: { items: [item] },
    attachmentsByItem: new Map(),
  });

  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].providerReference, "entry:shared");
});
