import assert from "node:assert/strict";
import test from "node:test";
import { discoverCourseMedia, discoverCourseMediaGallery } from "../src/media/workflow.mjs";

const COURSE = {
  key: "MH1101",
  courseId: "_9_1",
  destination: "/courses/MH1101/NTULearn",
  mediaMode: "pilot",
};

test("uses the signed-in browser seam only for enabled courses", async () => {
  let opened = 0;
  const result = await discoverCourseMediaGallery({
    client: {
      async withBrowserPage(read) {
        opened += 1;
        return read({ signedIn: true });
      },
    },
    course: COURSE,
    async readGallery({ page, course }) {
      assert.equal(page.signedIn, true);
      assert.equal(course.key, COURSE.key);
      return { complete: true, recordings: ["gallery-1"] };
    },
  });

  assert.equal(opened, 1);
  assert.deepEqual(result.recordings, ["gallery-1"]);

  const off = await discoverCourseMediaGallery({
    client: {
      async withBrowserPage() {
        throw new Error("off course must not open the gallery");
      },
    },
    course: { ...COURSE, mediaMode: "off" },
  });
  assert.equal(off.skipped, true);
});

test("combines content-tree and Media Gallery appearances into one enabled-course queue", async () => {
  const item = {
    id: "lecture-item",
    parentId: null,
    position: 0,
    title: "Week 1",
    contentHandler: "resource/x-bb-document",
    body: { displayText: '<iframe src="https://youtu.be/lecture123"></iframe>' },
  };
  const result = await discoverCourseMedia({
    client: {
      async readCourse(courseId) {
        assert.equal(courseId, COURSE.courseId);
        return { items: [item] };
      },
      async readAttachments() {
        return [];
      },
      async withBrowserPage(read) {
        return read({ signedIn: true });
      },
    },
    course: COURSE,
    async readGallery() {
      return {
        complete: true,
        verdict: "green",
        displayedCount: 1,
        discoveredCount: 1,
        recordings: [{ recordingId: "media-gallery:gallery-1" }],
        queue: [{ recordingId: "media-gallery:gallery-1" }],
        limitations: [],
      };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.contentCount, 1);
  assert.equal(result.galleryCount, 1);
  assert.equal(result.discoveredCount, 2);
  assert.deepEqual(
    result.queue.map(({ recordingId }) => recordingId),
    ["content-tree:_9_1:lecture-item:youtube:lecture123", "media-gallery:gallery-1"],
  );
});

test("passes injected content adapters through the discovery workflow", async () => {
  let classified = 0;
  const adapter = {
    classify({ value, sourceKind }) {
      if (value !== "https://fixture.example.test/player" || sourceKind !== "embedded-player") {
        return null;
      }
      classified += 1;
      return {
        provider: "fixture-media",
        providerReference: "fixture-media:id:lecture-1",
      };
    },
  };
  const result = await discoverCourseMedia({
    client: {
      async readCourse() {
        return {
          items: [
            {
              id: "fixture-item",
              parentId: null,
              position: 0,
              title: "Fixture lecture",
              contentHandler: "resource/x-bb-document",
              body: { displayText: '<iframe src="https://fixture.example.test/player"></iframe>' },
            },
          ],
        };
      },
      async readAttachments() {
        return [];
      },
      async withBrowserPage(read) {
        return read({ signedIn: true });
      },
    },
    course: COURSE,
    adapters: [adapter],
    async readGallery() {
      return { complete: true, recordings: [], queue: [], discoveredCount: 0 };
    },
  });

  assert.equal(classified, 1);
  assert.equal(result.contentRecordings[0].providerReference, "fixture-media:id:lecture-1");
});
