import assert from "node:assert/strict";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { expectedFiles } from "../src/sync/expected.mjs";

const CLIENT = {
  readAttachments: async (courseId, item) => attachmentsOf(item),
};

const COURSE = { displayName: "Sustainability", id: "_9_1" };

function withFile(item, fileName) {
  return {
    ...item,
    contentDetail: {
      ...item.contentDetail,
      "resource/x-bb-file": { file: { fileName, permanentUrl: `/${fileName}` } },
    },
  };
}

async function expected(items, announcements = []) {
  const snapshot = { course: COURSE, items, announcements };
  const found = [];
  for await (const each of expectedFiles({ client: CLIENT, courseId: "_9_1", snapshot })) {
    found.push(each);
  }
  return found;
}

function pathsOf(found, kind) {
  return found.filter((each) => each.kind === kind).map((each) => each.placement.path);
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
  const attachments = found.filter((each) => each.kind === "attachment");

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].item.id, "_2_1");
  assert.equal(attachments[0].attachment.fileName, "Notes.pdf");
  assert.equal(attachments[0].placement.path, "01 Week 1/04 Notes.pdf");
  assert.equal(attachments[0].placement.trail, "Week 1");
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
  assert.deepEqual(pathsOf(await expected([folder]), "attachment"), []);
});

test("expects the course overview at the root of the destination", async () => {
  const [first] = await expected([]);

  assert.equal(first.kind, "document");
  assert.equal(first.placement.path, "Course.md");
  assert.match(first.content, /^# Sustainability\n/);
});

// PS0002's forty-four recorded lectures are external links: no attachment, so the attachment count
// is blind to every one of them, and a page naming the link is the whole of what a run writes (#32).
test("expects a page for an item whose only content is a link out", async () => {
  const found = await expected([
    {
      id: "_1_1",
      parentId: null,
      position: 0,
      title: "Topic 1",
      contentHandler: "resource/x-bb-externallink",
      contentDetail: { "resource/x-bb-externallink": { url: "https://kaltura.example/one" } },
    },
  ]);

  assert.deepEqual(pathsOf(found, "attachment"), []);
  assert.deepEqual(pathsOf(found, "document"), ["Course.md", "01 Topic 1.md"]);
  const page = found.find((each) => each.placement.path === "01 Topic 1.md");
  assert.equal(page.placement.file, "Topic 1.md");
  assert.match(page.content, /https:\/\/kaltura\.example\/one/);
});

// Expecting one under every folder would invent a gap beneath each bare one, which is the crying
// wolf ADR-0005 refuses at a larger scale.
test("expects a folder's own document only where the folder has something to say", async () => {
  const bare = {
    id: "_1_1",
    parentId: null,
    position: 0,
    title: "Week 1",
    contentHandler: "resource/x-bb-folder",
  };
  const described = {
    ...bare,
    id: "_2_1",
    position: 1,
    title: "Week 2",
    description: "<p>Read chapter two.</p>",
  };
  const found = await expected([bare, described]);

  assert.deepEqual(pathsOf(found, "document"), ["Course.md", "02 Week 2/_NTULearn.md"]);
  assert.deepEqual(
    found.filter((each) => each.kind === "folder").map((each) => each.placement.segments),
    [["01 Week 1"], ["02 Week 2"]],
  );
});

// An item whose attachment is its own trace gets no document beside it, and one with nothing at all
// gets the document ADR-0006 requires — so what is expected of the two differs by exactly one file.
test("expects a document for an uncopied item and none for one its attachment speaks for", async () => {
  const found = await expected([
    {
      id: "_1_1",
      parentId: null,
      position: 2,
      title: "Knowledge Check",
      contentHandler: "resource/x-bb-asmt-test-link",
    },
    withFile({ id: "_2_1", parentId: null, position: 4, title: "Week 1 PPT" }, "Week 1 PPT.pptx"),
  ]);

  assert.deepEqual(pathsOf(found, "uncopied"), ["03 Knowledge Check.md"]);
  assert.deepEqual(pathsOf(found, "document"), ["Course.md"]);
  assert.deepEqual(pathsOf(found, "attachment"), ["05 Week 1 PPT.pptx"]);
});

test("expects each announcement where the sync files it", async () => {
  const found = await expected(
    [],
    [{ id: "a1", title: "Welcome", createdDate: "2026-01-06T09:00:00.000Z" }],
  );

  assert.deepEqual(pathsOf(found, "document"), [
    "Course.md",
    "Announcements/2026-01-06 Welcome.md",
  ]);
});
