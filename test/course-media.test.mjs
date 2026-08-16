import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { syncCourse } from "../src/sync/course.mjs";

test("discovers Kaltura appearances during an enabled course walk without running the media job", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-media-"));
  const course = {
    key: "MH2100",
    courseId: "_9_1",
    destination,
    mediaMode: "pilot",
  };
  const items = [
    {
      id: "folder",
      parentId: null,
      position: 0,
      title: "Lectures",
      contentHandler: "resource/x-bb-folder",
    },
    {
      id: "lecture",
      parentId: "folder",
      position: 0,
      title: "Week 1",
      contentHandler: "resource/x-bb-document",
      body: {
        displayText:
          '<iframe src="https://video.example.test/entry_id/lecture-1?ks=expiring"></iframe>',
      },
    },
  ];
  const client = {
    async readCourse() {
      return { course: { displayName: "MH2100" }, announcements: [], conversations: [], items };
    },
    async readAttachments() {
      return [];
    },
    async download() {
      throw new Error("the media worker must not run during sync");
    },
  };

  const result = await syncCourse({
    client,
    course,
    state: { version: 1, courses: {} },
  });

  assert.equal(result.recordings.length, 1);
  assert.equal(result.recordings[0].providerReference, "entry:lecture-1");
  assert.deepEqual((await readdir(join(destination, "01 Lectures"))).sort(), ["01 Week 1.md"]);
});
