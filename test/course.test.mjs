import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
const QUIZ = "03 ⭐Topic 1_ Knowledge Check Points.md";

// CC0006's Week 1, trimmed to the two children that decide whether a document is written: a quiz
// NTULearn holds nothing copyable for, and a file whose attachment is its own trace (#20).
const WEEK_1 = [
  {
    id: "_1_1",
    parentId: null,
    position: 0,
    title: "Week 1",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_2_1",
    parentId: "_1_1",
    position: 2,
    title: "⭐Topic 1: Knowledge Check Points",
    contentHandler: "resource/x-bb-asmt-test-link",
  },
  {
    id: "_3_1",
    parentId: "_1_1",
    position: 4,
    title: "Week 1 PPT",
    contentHandler: "resource/x-bb-file",
    contentDetail: {
      "resource/x-bb-file": {
        file: { fileName: "Week 1 PPT.pptx", permanentUrl: "/bbcswebdav/w1" },
      },
    },
  },
];

function client(download, items) {
  return {
    readCourse: async () => ({
      course: { displayName: "Career Pathways" },
      announcements: [],
      conversations: [],
      items,
    }),
    readAttachments: async (courseId, item) => attachmentsOf(item),
    download,
  };
}

const downloads = (content) => async () => ({ body: Buffer.from(content), headers: {} });

async function sync(download, items = ITEMS) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-"));
  const course = { key: "CC0006", courseId: "_9_1", destination };
  const state = { version: 1, courses: {} };
  return {
    destination,
    result: await syncCourse({ client: client(download, items), course, state }),
  };
}

test("writes an attachment to the path its placement names", async () => {
  const { destination, result } = await sync(downloads("pdf"));

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
  assert.equal(result.uncopied, 0);
});

// The quiz at position 2 wrote nothing at all, so the missing `03` beside the file's `05` was the
// only evidence it had ever been there — which reads as a bug in the numbering (#20, ADR-0006).
test("writes down an item that would otherwise leave nothing but a gap in the numbering", async () => {
  const { destination, result } = await sync(downloads("ppt"), WEEK_1);
  const written = join(destination, "01 Week 1", QUIZ);

  assert.match(await readFile(written, "utf8"), /^# ⭐Topic 1: Knowledge Check Points\n/);
  assert.match(await readFile(written, "utf8"), /- Trail: Week 1\n/);
  assert.equal(result.uncopied, 1);
});

test("leaves the item whose attachment is already its trace without a document beside it", async () => {
  const { destination } = await sync(downloads("ppt"), WEEK_1);

  assert.deepEqual((await readdir(join(destination, "01 Week 1"))).sort(), [
    QUIZ,
    "05 Week 1 PPT.pptx",
  ]);
});

// A page hidden by a release rule arrives carrying nothing, exactly as an uncopiable item does,
// and the student's copy of it is the thing ADR-0003 exists to protect.
test("never writes over a page an earlier run copied", async () => {
  const { destination, result } = await sync(downloads("ppt"), WEEK_1);
  const written = join(destination, "01 Week 1", QUIZ);
  await writeFile(written, "# The week the quiz still had a page\n");

  const again = await syncCourse({
    client: client(downloads("ppt"), WEEK_1),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state: { version: 1, courses: {} },
  });

  assert.equal(await readFile(written, "utf8"), "# The week the quiz still had a page\n");
  assert.equal(result.uncopied, 1);
  assert.equal(again.uncopied, 1);
});

// ML0004's seven topics are SCORM packages: no file to fetch, and a launch address NTULearn hands
// over in a field of its own. The link is the whole of what can be kept, so an item carrying one is
// a page rather than something there was nothing to copy from (#53).
test("writes a SCORM topic down as its launch link rather than as nothing to copy", async () => {
  const scorm = [
    {
      id: "_1_1",
      parentId: null,
      position: 0,
      title: "Week 1",
      contentHandler: "resource/x-bb-folder",
    },
    {
      id: "_2_1",
      parentId: "_1_1",
      position: 2,
      title: "T1 - Welcoming the Future World",
      contentHandler: "resource/x-plugin-scormengine",
      contentDetail: {
        "resource/x-plugin-scormengine": {
          launchUrl: "/webapps/scor/delivery?action=launchPackage",
        },
      },
    },
  ];
  const { destination, result } = await sync(downloads("ppt"), scorm);
  const written = await readFile(
    join(destination, "01 Week 1", "03 T1 - Welcoming the Future World.md"),
    "utf8",
  );

  assert.match(
    written,
    /## External link\n\nhttps:\/\/ntulearn\.ntu\.edu\.sg\/webapps\/scor\/delivery\?action=launchPackage/,
  );
  assert.doesNotMatch(written, /nothing to copy/);
  assert.equal(result.uncopied, 0);
});

// The statement that there was nothing to copy is the sync's own writing rather than the student's,
// so correcting it takes nothing from anybody — which is how a destination written before a fix
// stops repeating what the fix removed (#53).
test("supersedes its own statement that there was nothing to copy", async () => {
  const { destination } = await sync(downloads("ppt"), WEEK_1);
  const written = join(destination, "01 Week 1", QUIZ);
  const current = await readFile(written, "utf8");
  await writeFile(written, current.replace("- Kind: Test", "- Kind: resource/x-bb-asmt-test-link"));

  await syncCourse({
    client: client(downloads("ppt"), WEEK_1),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state: { version: 1, courses: {} },
  });

  assert.equal(await readFile(written, "utf8"), current);
});
