import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { verifyCourse, verifyReport } from "../src/sync/verify.mjs";

const ITEMS = [
  {
    id: "_1_1",
    parentId: null,
    position: 0,
    title: "Lecture Notes",
    contentHandler: "resource/x-bb-folder",
  },
  {
    id: "_2_1",
    parentId: "_1_1",
    position: 0,
    title: "ultraDocumentBody",
    contentHandler: "resource/x-bb-document",
    contentDetail: {
      "resource/x-bb-file": { file: { fileName: "Week 1.pdf", permanentUrl: "/one" } },
    },
  },
  {
    id: "_3_1",
    parentId: "_1_1",
    position: 1,
    title: "ultraDocumentBody",
    contentHandler: "resource/x-bb-document",
    contentDetail: {
      "resource/x-bb-file": { file: { fileName: "Week 2.pdf", permanentUrl: "/two" } },
    },
  },
];

const CLIENT = {
  readCourse: async () => ({
    course: { displayName: "Lectures" },
    announcements: [],
    conversations: [],
    items: ITEMS,
  }),
  readAttachments: async (courseId, item) => attachmentsOf(item),
  download: async () => assert.fail("verify downloads nothing"),
};

async function destinationHolding(...files) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-verify-"));
  for (const file of files) {
    await mkdir(join(destination, "01 Lecture Notes"), { recursive: true });
    await writeFile(join(destination, file), "pdf");
  }
  return destination;
}

test("counts the attachments that arrived and names the ones that did not", async () => {
  const destination = await destinationHolding("01 Lecture Notes/01 Week 1.pdf");
  const result = await verifyCourse({
    client: CLIENT,
    course: { key: "MH2100", courseId: "_9_1", destination },
  });

  assert.equal(result.key, "MH2100");
  assert.equal(result.course, "Lectures");
  assert.equal(result.attachments, 2);
  assert.equal(result.present, 1);
  assert.deepEqual(result.missing, [
    { file: "Week 2.pdf", trail: "Lecture Notes", path: "01 Lecture Notes/02 Week 2.pdf" },
  ]);
});

test("reports a destination that has everything as missing nothing", async () => {
  const destination = await destinationHolding(
    "01 Lecture Notes/01 Week 1.pdf",
    "01 Lecture Notes/02 Week 2.pdf",
  );
  const result = await verifyCourse({
    client: CLIENT,
    course: { key: "MH2100", courseId: "_9_1", destination },
  });

  assert.equal(result.present, 2);
  assert.deepEqual(result.missing, []);
});

// It answers a question about the destination, so it may not change the answer while asking it.
test("writes nothing to the destination", async () => {
  const destination = await destinationHolding();
  await verifyCourse({ client: CLIENT, course: { key: "MH2100", courseId: "_9_1", destination } });
  assert.deepEqual(await readdir(destination), []);
});

test("adds the courses up and says whether the whole of what was asked for is there", () => {
  const short = { attachments: 10, present: 4, missing: [{}, {}, {}, {}, {}, {}] };
  const whole = { attachments: 49, present: 49, missing: [] };

  assert.deepEqual(verifyReport([short, whole]), {
    attachments: 59,
    present: 53,
    complete: false,
    courses: [short, whole],
  });
  assert.equal(verifyReport([whole]).complete, true);
  assert.equal(verifyReport([]).complete, true);
});
