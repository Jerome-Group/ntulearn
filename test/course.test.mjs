import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { syncCourse } from "../src/sync/course.mjs";

const ITEMS = [
  {
    id: "_1_1",
    parentId: null,
    position: 8,
    title: "Career Pathways Platform",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_2_1",
    parentId: "_1_1",
    position: 2,
    title: "Instruction Manual",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_3_1",
    parentId: "_2_1",
    position: 0,
    title: "ultraDocumentBody",
    contentHandler: "resource/x-bb-document",
    contentDetail: {
      "resource/x-bb-file": { file: { fileName: "Guide.pdf", permanentUrl: "/bbcswebdav/guide" } },
    },
  },
];

const AT = "09 Career Pathways Platform/03 Instruction Manual/01 Guide.pdf";

function client(download) {
  return {
    readCourse: async () => ({
      course: { displayName: "Career Pathways" },
      announcements: [],
      conversations: [],
      items: ITEMS,
    }),
    readAttachments: async (courseId, item) => attachmentsOf(item),
    download,
  };
}

async function sync(download) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-"));
  const course = { key: "CC0006", courseId: "_9_1", destination };
  const state = { version: 1, courses: {} };
  return { destination, result: await syncCourse({ client: client(download), course, state }) };
}

test("writes an attachment to the path its placement names", async () => {
  const { destination, result } = await sync(async () => ({
    body: Buffer.from("pdf"),
    headers: {},
  }));

  assert.equal(await readFile(join(destination, AT), "utf8"), "pdf");
  assert.deepEqual(result.failures, []);
  assert.equal(result.downloaded, 1);
});

// `item` used to be the whole of a failure's location, and it is `ultraDocumentBody` for every
// embedded document in a course — so the field meant to find the file named nothing (#21).
test("says where a failed download came from and where it would have gone", async () => {
  const { result } = await sync(async () => {
    throw new Error("Download failed: HTTP 404");
  });

  assert.deepEqual(result.failures, [
    {
      file: "Guide.pdf",
      trail: "Career Pathways Platform › Instruction Manual",
      path: AT,
      error: "Download failed: HTTP 404",
    },
  ]);
});
