import assert from "node:assert/strict";
import test from "node:test";
import { discoverCourseMediaGallery } from "../src/media/workflow.mjs";

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
