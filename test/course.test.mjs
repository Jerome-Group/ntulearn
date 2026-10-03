import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const downloads =
  (content, headers = {}) =>
  async () => ({ body: Buffer.from(content), headers });

async function sync(download, items = ITEMS) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-"));
  const course = { key: "CC0006", courseId: "_9_1", destination };
  const state = { version: 1, courses: {} };
  return {
    destination,
    state,
    result: await syncCourse({ client: client(download, items), course, state }),
  };
}

test("writes an attachment to the path its placement names", async () => {
  const { destination, result } = await sync(downloads("pdf"));

  assert.equal(await readFile(join(destination, AT), "utf8"), "pdf");
  assert.deepEqual(result.failures, []);
  assert.equal(result.downloaded, 1);
});

test("hands enabled course appearances to discovery without running media work", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-media-"));
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
        displayText: '<iframe src="https://video.example.test/entry_id/lecture-1"></iframe>',
      },
    },
  ];
  const seen = [];
  const result = await syncCourse({
    client: {
      async readCourse() {
        return { course: { displayName: "MH2100" }, announcements: [], conversations: [], items };
      },
      async readAttachments(courseId, item) {
        seen.push([courseId, item.id]);
        return [];
      },
      async download() {
        throw new Error("media work must not run during sync");
      },
    },
    course: { key: "MH2100", courseId: "_9_1", destination, mediaMode: "pilot" },
    state: { version: 1, courses: {} },
    recordingDiscovery({ attachmentsByItem }) {
      assert.equal(attachmentsByItem.get("lecture").length, 0);
      return [{ recordingId: "content-tree:_9_1:lecture:entry:lecture-1" }];
    },
  });

  assert.deepEqual(seen, [["_9_1", "lecture"]]);
  assert.deepEqual(result.recordings, [
    { recordingId: "content-tree:_9_1:lecture:entry:lecture-1" },
  ]);
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

// The largest number in a run's report was the same whether it wrote everything or nothing, which
// is the number a reader of an unattended run learns to skip (#55).
test("says what it wrote, not only what the copy holds", async () => {
  const { destination, result } = await sync(downloads("ppt"), WEEK_1);
  const overview = join(destination, "Course.md");
  const quiz = join(destination, "01 Week 1", QUIZ);

  // The course overview and the quiz's document; the folder's own document is empty and the
  // file's trace is its attachment, so neither is written at all.
  assert.equal(result.markdown, 2);
  assert.equal(result.markdownWritten, 2);

  const [overviewBefore, quizBefore] = await Promise.all([
    readFile(overview, "utf8"),
    readFile(quiz, "utf8"),
  ]);
  const again = await syncCourse({
    client: client(downloads("ppt"), WEEK_1),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state: { version: 1, courses: {} },
  });

  // Every document's text comes from the course and nothing in the course moved, so a second run
  // writes none of them. `Course.md` used to be the exception — it stamped the run's own time into
  // itself — which put a floor of one per course under this number and left it unable to say that
  // a run changed nothing at all (#57, ADR-0008).
  assert.equal(await readFile(quiz, "utf8"), quizBefore);
  assert.equal(await readFile(overview, "utf8"), overviewBefore);
  assert.equal(again.markdown, 2);
  assert.equal(again.markdownWritten, 0);
});

// The human-readable time the run happened lives outside the overview it was making unstable. The
// machine-readable receipt beside it carries the separate health question (ADR-0008, ADR-0015).
test("records when the run happened in a file of its own, outside the document counts", async () => {
  const { destination, result } = await sync(downloads("ppt"), WEEK_1);
  const stamp = join(destination, "Last synced.md");

  assert.match(await readFile(stamp, "utf8"), /^# Last synced\n/);
  assert.match(await readFile(stamp, "utf8"), /- Synced: \d{4}-\d\d-\d\dT[\d:.]+Z\n/);

  // The overview and the quiz's document; a stamp is a record of the run rather than a document of
  // the course, so counting it would put back the floor this record removed.
  assert.equal(result.markdown, 2);
  assert.equal(result.markdownWritten, 2);
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

// ADR-0016 supersedes the old correction allowance: a marker proves origin, not whether somebody
// annotated the document after the run wrote it.
test("retains an occupied marked stand-in instead of automatically correcting it", async () => {
  const { destination } = await sync(downloads("ppt"), WEEK_1);
  const written = join(destination, "01 Week 1", QUIZ);
  const current = await readFile(written, "utf8");
  await writeFile(written, current.replace("- Kind: Test", "- Kind: resource/x-bb-asmt-test-link"));

  const result = await syncCourse({
    client: client(downloads("ppt"), WEEK_1),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state: { version: 1, courses: {} },
  });

  assert.equal(
    await readFile(written, "utf8"),
    current.replace("- Kind: Test", "- Kind: resource/x-bb-asmt-test-link"),
  );
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /retained.*Compare/);
});

// A read the student may not make yields nothing, and nothing is not the same as "there are none".
// Overwriting the recorded ids with an empty list would report every announcement as new on the run
// after the permission comes back, and would call the course cleanly synced while a whole category
// of it went unread.
test("keeps what the last run recorded when a category could not be read", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-course-"));
  const state = {
    version: 1,
    courses: {
      CC0006: {
        announcementIds: ["a1", "a2"],
        conversationIds: ["c1"],
        contentIds: [],
        downloads: {},
      },
    },
  };
  const unreadable = {
    ...client(downloads("ppt"), []),
    readCourse: async () => ({
      course: { displayName: "Career Pathways" },
      announcements: [],
      conversations: [],
      unavailable: { announcements: true, conversations: true },
      items: [],
    }),
  };

  const result = await syncCourse({
    client: unreadable,
    course: { key: "CC0006", courseId: "_9_1", destination },
    state,
  });

  assert.deepEqual(state.courses.CC0006.announcementIds, ["a1", "a2"]);
  assert.deepEqual(state.courses.CC0006.conversationIds, ["c1"]);
  assert.equal(result.newAnnouncements, 0);
  assert.deepEqual(result.unread, ["announcements", "conversations"]);
});

// One item inserted at the top of a course moves every later name by one, and nothing on disk moves
// with it, because a sync never renames (ADR-0003). The run used to hold a record to the path it
// would write today, so the whole tail of the course read as changed and was fetched again under
// its new number — 61 files in one course, with nothing to say which copy was current (#70).
const REORDERED = WEEK_1.map((item) => ({ ...item, position: item.position + 1 }));
const WEEK_1_PPT = "/bbcswebdav/w1";
// The whole of the destination's root once the course has been synced. Asserted rather than the
// folder alone, because the failure this is watching for is a *second* `Week 1` beside the first.
const ROOT = [
  "01 Week 1",
  "Course.md",
  "Last synced.md",
  "Sync status.json",
  "Source editions",
].sort();

async function again(destination, state, items = WEEK_1) {
  return syncCourse({
    client: client(downloads("ppt"), items),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state,
  });
}

test("writes nothing a second time when every number in the course has moved", async () => {
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);
  const before = await readdir(join(destination, "01 Week 1"));

  const second = await again(destination, state, REORDERED);

  // The file and the quiz's document, both found under the number they were written with.
  assert.equal(second.renumbered, 2);
  assert.equal(second.downloaded, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.markdownWritten, 0);
  assert.deepEqual((await readdir(join(destination, "01 Week 1"))).sort(), before.sort());
  assert.deepEqual((await readdir(destination)).sort(), ROOT);
});

// `State` is a cache that costs nothing to delete (`CONTEXT.md`, ADR-0003), so the duplication has
// to be answered by what is on disk rather than by what a record remembers. Without one the run
// fetches the bytes again, finds them already there under the earlier number, and writes nothing.
test("keeps the file where it is when no record says it was ever downloaded", async () => {
  const { destination } = await sync(downloads("ppt"), WEEK_1);

  const second = await again(destination, { version: 1, courses: {} }, REORDERED);

  assert.equal(second.downloaded, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.renumbered, 2);
  assert.equal(await readFile(join(destination, "01 Week 1", "05 Week 1 PPT.pptx"), "utf8"), "ppt");
  assert.deepEqual((await readdir(destination)).sort(), ROOT);
});

// ADR-0016 refuses a differing older placement too: a mismatch may be an annotation, and a new
// number is not permission to create a second version beside it.
test("reports a conflict at a differing earlier-number attachment without creating another copy", async () => {
  const { destination } = await sync(downloads("ppt"), WEEK_1);
  const second = await syncCourse({
    client: client(downloads("a different deck"), REORDERED),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state: { version: 1, courses: {} },
  });
  assert.equal(second.downloaded, 0);
  assert.equal(second.failures.length, 1);
  assert.equal(await readFile(join(destination, "01 Week 1", "05 Week 1 PPT.pptx"), "utf8"), "ppt");
  await assert.rejects(readFile(join(destination, "01 Week 1", "06 Week 1 PPT.pptx")), {
    code: "ENOENT",
  });
  assert.deepEqual((await readdir(destination)).sort(), ROOT);
});

// Resolving only the file leaves the folder to be created afresh under its new number, so the run
// keeps everything it already had in one place and puts everything since in another — a course split
// across two directories, which is worse than the duplication #70 reported. The folder is resolved
// first and the name resolved inside it, so a new item joins its siblings.
test("puts an item the destination has never seen in with its siblings", async () => {
  const added = [
    ...REORDERED,
    {
      id: "_4_1",
      parentId: "_1_1",
      position: 7,
      title: "Week 1 Notes",
      contentHandler: "resource/x-bb-file",
      contentDetail: {
        "resource/x-bb-file": {
          file: { fileName: "Week 1 Notes.pdf", permanentUrl: "/bbcswebdav/n1" },
        },
      },
    },
  ];
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);

  const second = await again(destination, state, added);

  assert.equal(second.downloaded, 1);
  assert.deepEqual((await readdir(join(destination, "01 Week 1"))).sort(), [
    QUIZ,
    "05 Week 1 PPT.pptx",
    "08 Week 1 Notes.pdf",
  ]);
  assert.deepEqual((await readdir(destination)).sort(), ROOT);
});

// A record's `relativePath` is where the file is, so the run after a reorder finds it there rather
// than working the numbering out a second time.
test("records where the file is rather than the number the course gives it today", async () => {
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);

  await again(destination, state, REORDERED);

  assert.equal(
    state.courses.CC0006.downloads[WEEK_1_PPT].relativePath,
    "01 Week 1/05 Week 1 PPT.pptx",
  );
});

// A page the student replaced is theirs, and a reorder does not hand the run a fresh name to write
// it under: the statement that there was nothing to copy is superseded where the file actually is.
test("never writes over a page an earlier run copied, at whatever number it now has", async () => {
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);
  const written = join(destination, "01 Week 1", QUIZ);
  await writeFile(written, "# The week the quiz still had a page\n");

  await again(destination, state, REORDERED);

  assert.equal(await readFile(written, "utf8"), "# The week the quiz still had a page\n");
  assert.deepEqual((await readdir(destination)).sort(), ROOT);
});

// NTULearn's claim about a file is a claim; the `content-type` that came back is what the run
// actually saw. A cache of a run holds the second, and the first only where they disagree — which
// is the one moment either is worth reading (#60).
const CLAIMS_PDF = [
  { ...ITEMS[0] },
  { ...ITEMS[1] },
  {
    ...ITEMS[2],
    contentDetail: {
      "resource/x-bb-file": {
        file: { ...ITEMS[2].contentDetail["resource/x-bb-file"].file, mimeType: "application/pdf" },
      },
    },
  },
];
const RESOURCE = "/bbcswebdav/guide";

test("records the type the download arrived with, not the type NTULearn claimed", async () => {
  const { state } = await sync(
    downloads("pdf", { "content-type": "application/octet-stream" }),
    CLAIMS_PDF,
  );

  const record = state.courses.CC0006.downloads[RESOURCE];

  assert.equal(record.mimeType, "application/octet-stream");
  assert.equal(record.claimedMimeType, "application/pdf");
});

// The type is no part of what decides whether a file is fetched again, so a record written before
// this change — one field, holding the claim — still matches and is not downloaded twice
// (ADR-0003).
test("does not download again a file whose record was written before the type moved", async () => {
  const { destination, state } = await sync(downloads("pdf"), CLAIMS_PDF);
  const { fingerprint, relativePath, bytes, sha256 } = state.courses.CC0006.downloads[RESOURCE];
  state.courses.CC0006.downloads[RESOURCE] = {
    fingerprint,
    relativePath,
    bytes,
    sha256,
    mimeType: "application/pdf",
  };

  const again = await syncCourse({
    client: client(downloads("pdf"), CLAIMS_PDF),
    course: { key: "CC0006", courseId: "_9_1", destination },
    state,
  });

  assert.equal(again.downloaded, 0);
  assert.equal(again.skipped, 1);
});

test("publishes distinct announcement editions without changing a legacy or user file", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-collision-"));
  const course = { key: "SYNTHETIC", courseId: "synthetic", destination };
  const announcements = [
    {
      id: "a",
      title: "Reminder: today",
      createdDate: "2026-01-06T01:00:00Z",
      body: { rawText: "FIRST" },
    },
    {
      id: "b",
      title: "reminder? today",
      createdDate: "2026-01-06T02:00:00Z",
      body: { rawText: "SECOND" },
    },
  ];
  const legacy = join(destination, "Announcements", "2026-01-06 Reminder_ today.md");
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, "USER EDIT");
  const snapshot = {
    course: { displayName: "Synthetic" },
    items: [],
    announcements,
    conversations: [],
  };
  const reader = { readCourse: async () => snapshot };
  for (const order of [announcements, [...announcements].reverse()]) {
    snapshot.announcements = order;
    const result = await syncCourse({ client: reader, course, state: { courses: {} } });
    assert.equal(result.failures.length, 0);
    assert.equal(await readFile(legacy, "utf8"), "USER EDIT");
    assert.equal(
      JSON.parse(await readFile(join(destination, "Sync status.json"), "utf8")).status,
      "complete",
    );
  }
  snapshot.announcements = announcements.map((announcement, index) => ({
    ...announcement,
    title: `Distinct ${index}`,
  }));
  const recovered = await syncCourse({ client: reader, course, state: { courses: {} } });
  assert.equal(recovered.failures.length, 0);
  assert.equal(await readFile(legacy, "utf8"), "USER EDIT");
  assert.equal(
    JSON.parse(await readFile(join(destination, "Sync status.json"), "utf8")).status,
    "complete",
  );
});

test("rejects a renumbered symlink descendant before writing outside the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-containment-"));
  const destination = join(root, "destination");
  const outside = join(root, "outside");
  await mkdir(destination);
  await mkdir(outside);
  await symlink(outside, join(destination, "04 Week"));
  const items = [
    { id: "folder", title: "Week", position: 0, contentHandler: "resource/x-bb-folder" },
    {
      id: "file",
      parentId: "folder",
      title: "File",
      position: 0,
      contentHandler: "resource/x-bb-file",
    },
  ];
  const reader = {
    readCourse: async () => ({
      course: { displayName: "Synthetic" },
      items,
      announcements: [],
      conversations: [],
    }),
    readAttachments: async (_, item) =>
      item.id === "file" ? [{ fileName: "synthetic.txt", resourceUrl: "/synthetic" }] : [],
    download: async () => ({ body: Buffer.from("SYNTHETIC"), headers: {} }),
  };
  await assert.rejects(
    syncCourse({
      client: reader,
      course: { key: "SYNTHETIC", courseId: "synthetic", destination },
      state: { courses: {} },
    }),
    /symlink/i,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.equal(
    JSON.parse(await readFile(join(destination, "Sync status.json"), "utf8")).status,
    "failed",
  );
});

test("retains occupied attachment and annotated documents, reports partial, and recovers at an empty path", async (t) => {
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);
  t.after(() => rm(destination, { recursive: true, force: true }));
  const overview = join(destination, "Course.md");
  const placeholder = join(destination, "01 Week 1", QUIZ);
  const attachment = join(destination, "01 Week 1", "05 Week 1 PPT.pptx");
  const originalOverview = `${await readFile(overview, "utf8")}\nMy overview annotation\n`;
  const originalPlaceholder = `${await readFile(placeholder, "utf8")}\nMy quiz annotation\n`;
  await writeFile(overview, originalOverview);
  await writeFile(placeholder, originalPlaceholder);
  await writeFile(attachment, "annotated attachment");
  const changed = WEEK_1.map((item) =>
    item.id === "_3_1" ? { ...item, modifiedDate: "2026-10-02T00:00:00Z" } : item,
  );
  let calls = 0;
  const updatedClient = client(async () => {
    calls += 1;
    return { body: Buffer.from("new upstream bytes"), headers: {} };
  }, changed);
  const course = { key: "CC0006", courseId: "_9_1", destination };
  const result = await syncCourse({ client: updatedClient, course, state });
  assert.equal(await readFile(overview, "utf8"), originalOverview);
  assert.equal(await readFile(placeholder, "utf8"), originalPlaceholder);
  assert.equal(await readFile(attachment, "utf8"), "annotated attachment");
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every((failure) => /retained.*Compare/.test(failure.error)));
  assert.equal(
    JSON.parse(await readFile(join(destination, "Sync status.json"), "utf8")).status,
    "partial",
  );
  await syncCourse({ client: updatedClient, course, state });
  assert.equal(await readFile(attachment, "utf8"), "annotated attachment");
  assert.equal(calls, 2);
  await unlink(attachment);
  const recovered = await syncCourse({ client: updatedClient, course, state });
  assert.equal(recovered.downloaded, 1);
  assert.equal(await readFile(attachment, "utf8"), "new upstream bytes");
  assert.equal(await readFile(overview, "utf8"), originalOverview);
});

test("uses recorded bytes to skip inaccurate upstream sizes and preserves truncated occupied files", async (t) => {
  const sized = ITEMS.map((item) =>
    item.id === "_3_1"
      ? {
          ...item,
          contentDetail: {
            "resource/x-bb-file": {
              file: { ...item.contentDetail["resource/x-bb-file"].file, fileSize: 100 },
            },
          },
        }
      : item,
  );
  let calls = 0;
  const download = async () => {
    calls += 1;
    return { body: Buffer.from("pdf"), headers: {} };
  };
  const { destination, state } = await sync(download, sized);
  t.after(() => rm(destination, { recursive: true, force: true }));
  const course = { key: "CC0006", courseId: "_9_1", destination };
  const reader = client(download, sized);
  const repeat = await syncCourse({ client: reader, course, state });
  assert.equal(calls, 1);
  assert.equal(repeat.skipped, 1);
  assert.equal(repeat.downloaded, 0);
  assert.equal(state.courses.CC0006.downloads[RESOURCE].bytes, 3);
  delete state.courses.CC0006.downloads[RESOURCE].bytes;
  const legacy = await syncCourse({ client: reader, course, state });
  assert.equal(calls, 2);
  assert.equal(legacy.skipped, 1);
  assert.equal(state.courses.CC0006.downloads[RESOURCE].bytes, 3);
  const held = join(destination, AT);
  await writeFile(held, "pd");
  const damaged = await syncCourse({ client: reader, course, state });
  assert.equal(calls, 3);
  assert.equal(damaged.failures.length, 1);
  assert.equal(await readFile(held, "utf8"), "pd");
  await unlink(held);
  const recovered = await syncCourse({ client: reader, course, state });
  assert.equal(recovered.downloaded, 1);
  assert.equal(await readFile(held, "utf8"), "pdf");
  await syncCourse({ client: reader, course, state });
  assert.equal(calls, 4);
});

test("retains annotations at an earlier-number marked stand-in without creating a rescue copy", async (t) => {
  const { destination, state } = await sync(downloads("ppt"), WEEK_1);
  t.after(() => rm(destination, { recursive: true, force: true }));
  const folder = join(destination, "01 Week 1");
  const held = join(folder, QUIZ);
  const annotation = `${await readFile(held, "utf8")}\nAnnotation retained across ordering changes\n`;
  const before = (await readdir(folder)).sort();
  await writeFile(held, annotation);
  const result = await again(destination, state, REORDERED);
  assert.equal(await readFile(held, "utf8"), annotation);
  assert.equal(result.failures.length, 1);
  assert.deepEqual((await readdir(folder)).sort(), before);
  assert.equal(result.skipped, 1);
});
