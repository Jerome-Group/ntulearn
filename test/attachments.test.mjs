import assert from "node:assert/strict";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { expectedAttachments } from "../src/sync/attachments.mjs";

const CLIENT = {
  readAttachments: async (courseId, item) => attachmentsOf(item),
};

function withFile(item, fileName) {
  return {
    ...item,
    contentDetail: {
      ...item.contentDetail,
      "resource/x-bb-file": { file: { fileName, permanentUrl: `/${fileName}` } },
    },
  };
}

async function expected(items) {
  const found = [];
  for await (const each of expectedAttachments({ client: CLIENT, courseId: "_9_1", items })) {
    found.push(each);
  }
  return found;
}

test("yields each attachment with the place it belongs", async () => {
  const found = await expected([
    {
      id: "_1_1",
      parentId: null,
      position: 0,
      title: "Week 1",
      contentHandler: "resource/x-bb-folder",
    },
    withFile(
      { id: "_2_1", parentId: "_1_1", position: 3, title: "ultraDocumentBody" },
      "Notes.pdf",
    ),
  ]);

  assert.equal(found.length, 1);
  assert.equal(found[0].item.id, "_2_1");
  assert.equal(found[0].attachment.fileName, "Notes.pdf");
  assert.equal(found[0].placement.path, "01 Week 1/04 Notes.pdf");
  assert.equal(found[0].placement.trail, "Week 1");
});

// A folder holds children rather than files, and the sync writes none of its own — so counting one
// would have `verify` waiting forever for a file no run will ever download.
test("expects nothing of a folder's own body", async () => {
  const folder = withFile(
    {
      id: "_3_1",
      parentId: null,
      position: 0,
      title: "Week 2",
      contentHandler: "resource/x-bb-folder",
    },
    "Stray.pdf",
  );
  assert.deepEqual(await expected([folder]), []);
});
