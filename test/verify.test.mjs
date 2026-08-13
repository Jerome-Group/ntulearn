import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  // PS0002's recorded lectures: a link out, carrying no attachment at all, so the count that only
  // ever held attachments against the destination was blind to every one of them (#32).
  {
    id: "_4_1",
    parentId: "_1_1",
    position: 2,
    title: "Video Lecture: Topic 1",
    contentHandler: "resource/x-bb-externallink",
    contentDetail: { "resource/x-bb-externallink": { url: "https://kaltura.example/one" } },
  },
];

const LECTURE = "01 Lecture Notes/03 Video Lecture_ Topic 1.md";

function clientReading(items) {
  return {
    readCourse: async () => ({
      course: { displayName: "Lectures" },
      announcements: [],
      conversations: [],
      items,
    }),
    readAttachments: async (courseId, item) => attachmentsOf(item),
    download: async () => assert.fail("verify downloads nothing"),
  };
}

const CLIENT = clientReading(ITEMS);

async function destinationHolding(...files) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-verify-"));
  for (const file of files) {
    const path = join(destination, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "written");
  }
  return destination;
}

function verify(destination, client = CLIENT) {
  return verifyCourse({ client, course: { key: "MH2100", courseId: "_9_1", destination } });
}

test("counts the files that arrived and names the ones that did not", async () => {
  const destination = await destinationHolding("01 Lecture Notes/01 Week 1.pdf");
  const result = await verify(destination);

  assert.equal(result.key, "MH2100");
  assert.equal(result.course, "Lectures");
  assert.equal(result.attachments, 2);
  assert.equal(result.documents, 2);
  assert.equal(result.files, 4);
  assert.equal(result.present, 1);
  assert.deepEqual(result.missing, [
    { file: "Course.md", trail: "", path: "Course.md" },
    { file: "Week 2.pdf", trail: "Lecture Notes", path: "01 Lecture Notes/02 Week 2.pdf" },
    { file: "Video Lecture: Topic 1.md", trail: "Lecture Notes", path: LECTURE },
  ]);
});

test("reports a destination that has everything as missing nothing", async () => {
  const destination = await destinationHolding(
    "Course.md",
    "01 Lecture Notes/01 Week 1.pdf",
    "01 Lecture Notes/02 Week 2.pdf",
    LECTURE,
  );
  const result = await verify(destination);

  assert.equal(result.present, 4);
  assert.deepEqual(result.missing, []);
});

// `ML0004-TUT` was fourteen items and no attachments at all, so the whole check was `0 === 0`: it
// reported complete for a destination that was empty, and would have for one that never existed.
test("does not call a course complete on the strength of its having no attachments", async () => {
  const items = [
    {
      id: "_1_1",
      parentId: null,
      position: 0,
      title: "T1 - Welcoming the Future World",
      contentHandler: "resource/x-plugin-scormengine",
      contentDetail: { "resource/x-plugin-scormengine": { launchUrl: "/webapps/scor/launch" } },
    },
  ];
  const result = await verify(await destinationHolding(), clientReading(items));

  assert.equal(result.attachments, 0);
  assert.equal(result.present, 0);
  assert.equal(verifyReport([result]).complete, false);
  assert.deepEqual(
    result.missing.map((each) => each.path),
    ["Course.md", "01 T1 - Welcoming the Future World.md"],
  );
});

// It answers a question about the destination, so it may not change the answer while asking it.
test("writes nothing to the destination", async () => {
  const destination = await destinationHolding();
  await verify(destination);
  assert.deepEqual(await readdir(destination), []);
});

// A destination only ever grows (ADR-0003), so what NTULearn has stopped returning is still
// correctly on disk. `verify` reads only at the paths NTULearn named, and so cannot see it at all.
test("says nothing about a file NTULearn no longer returns an item for", async () => {
  const destination = await destinationHolding(
    "Course.md",
    "01 Lecture Notes/01 Week 1.pdf",
    "01 Lecture Notes/02 Week 2.pdf",
    LECTURE,
    "01 Lecture Notes/09 Withdrawn Lecture.md",
  );
  const result = await verify(destination);

  assert.equal(result.files, 4);
  assert.deepEqual(result.missing, []);
});

// MH2100: an item inserted at the top of the course moved every later name by one, and the report
// called ninety-one files absent that were on disk under the number before (#67).
test("tells a file whose number moved from one that is not there", async () => {
  const destination = await destinationHolding(
    "Course.md",
    "02 Lecture Notes/01 Week 1.pdf",
    "02 Lecture Notes/02 Week 2.pdf",
  );
  const result = await verify(destination);

  assert.equal(result.files, 4);
  assert.equal(result.present, 3);
  assert.deepEqual(result.renumbered, [
    {
      file: "Week 1.pdf",
      trail: "Lecture Notes",
      path: "01 Lecture Notes/01 Week 1.pdf",
      onDisk: "02 Lecture Notes/01 Week 1.pdf",
    },
    {
      file: "Week 2.pdf",
      trail: "Lecture Notes",
      path: "01 Lecture Notes/02 Week 2.pdf",
      onDisk: "02 Lecture Notes/02 Week 2.pdf",
    },
  ]);
  assert.deepEqual(result.missing, [
    { file: "Video Lecture: Topic 1.md", trail: "Lecture Notes", path: LECTURE },
  ]);
});

// The cost of getting this wrong is not only the noise: the remedy a red report prints is
// `npm run sync`, which downloads every one of them again under its new number — and a destination
// only grows (ADR-0003), so both copies stay for good.
test("a course whose numbering moved is complete, and says so", async () => {
  const destination = await destinationHolding(
    "Course.md",
    "02 Lecture Notes/01 Week 1.pdf",
    "02 Lecture Notes/02 Week 2.pdf",
    "02 Lecture Notes/03 Video Lecture_ Topic 1.md",
  );
  const result = await verify(destination);
  const report = verifyReport([result]);

  assert.equal(result.present, 4);
  assert.deepEqual(result.missing, []);
  assert.equal(result.renumbered.length, 3);
  assert.equal(report.renumbered, 3);
  assert.equal(report.complete, true);
});

test("says nothing about numbering that has not moved", async () => {
  const destination = await destinationHolding(
    "Course.md",
    "01 Lecture Notes/01 Week 1.pdf",
    "01 Lecture Notes/02 Week 2.pdf",
    LECTURE,
  );
  const result = await verify(destination);

  assert.ok(!("renumbered" in result));
  assert.ok(!("renumbered" in verifyReport([result])));
});

// The same vacuity one level down: a category nobody could read hands back the empty list a course
// with nothing in it hands back, and a count made from that one is complete by expecting nothing.
test("says when a category the count is made of could not be read", async () => {
  const refused = {
    ...clientReading([]),
    readCourse: async () => ({
      course: { displayName: "Lectures" },
      announcements: [],
      conversations: [],
      unavailable: { announcements: true, conversations: true },
      items: [],
    }),
  };
  const result = await verify(await destinationHolding("Course.md"), refused);

  // Conversations are never copied, so a course that would not hand them over is one this command
  // expected nothing of to begin with.
  assert.deepEqual(result.unread, ["announcements"]);
  assert.equal(result.files, 1);
  assert.deepEqual(result.missing, []);
});

test("adds the courses up and says whether the whole of what was asked for is there", () => {
  const short = { files: 10, attachments: 6, documents: 4, present: 4, missing: [{}, {}] };
  const whole = { files: 49, attachments: 40, documents: 9, present: 49, missing: [] };
  const report = verifyReport([short, whole]);

  assert.equal(report.files, 59);
  assert.equal(report.attachments, 46);
  assert.equal(report.documents, 13);
  assert.equal(report.present, 53);
  assert.equal(report.complete, false);
  assert.deepEqual(report.courses, [short, whole]);
  assert.equal(verifyReport([whole]).complete, true);
  assert.equal(verifyReport([]).complete, true);
});

// A count is only ever as complete as the walk behind it, and this one's walk is a single read of
// the course. What it does not reach is part of the answer rather than a caveat on it (#36).
test("says what the number does not cover", () => {
  const report = verifyReport([]);

  assert.ok(report.notCovered.length >= 3);
  assert.ok(report.notCovered.every((line) => typeof line === "string" && line.length));
});

const REFUSED = [
  { key: "SLAF01", courseId: "_2694562_1", reason: "NTULearn refused course _2694562_1" },
];

// #66: a closed course expects nothing, so it cannot be a row like the others without inventing the
// zeroes #32 exists to remove — and it is said out loud rather than passed over in silence.
test("names a course NTULearn would not hand over, without counting it", () => {
  const whole = { files: 49, attachments: 40, documents: 9, present: 49, missing: [] };
  const report = verifyReport([whole], REFUSED);

  assert.deepEqual(report.refused, REFUSED);
  assert.equal(report.files, 49);
  assert.deepEqual(report.courses, [whole]);
  assert.ok(report.notCovered.some((line) => line.includes("refused")));
});

// There is no remedy to point at — signing in again opens nothing — and a red that is permanent is
// a red nobody reads. The report says the course was not read; the exit code stays about the files.
test("a course NTULearn would not hand over does not make the destination incomplete", () => {
  const whole = { files: 49, attachments: 40, documents: 9, present: 49, missing: [] };

  assert.equal(verifyReport([whole], REFUSED).complete, true);
  assert.equal(verifyReport([], REFUSED).complete, true);
});

test("says nothing about refused courses when every course was read", () => {
  assert.ok(!("refused" in verifyReport([])));
});
