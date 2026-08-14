import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { syncCourse } from "../src/sync/course.mjs";
import { renumberCourse, renumberReport } from "../src/sync/renumber.mjs";

// MH2500's shape, trimmed: handouts at the root of the course, and one tutorial inserted above them
// a week later that moved every one of their numbers by one (#74).
const handout = (id, position, name, parentId = null) => ({
  id,
  parentId,
  position,
  title: name,
  contentHandler: "resource/x-bb-file",
  contentDetail: {
    "resource/x-bb-file": { file: { fileName: `${name}.pdf`, permanentUrl: `/bbcswebdav/${id}` } },
  },
});

const HANDOUTS = [handout("_1_1", 0, "Hand00"), handout("_2_1", 1, "Hand01")];
const TUTORIAL = handout("_3_1", 0, "Tutorial 01");
const REORDERED = [TUTORIAL, ...HANDOUTS.map((each) => ({ ...each, position: each.position + 1 }))];

function client(items, download) {
  return {
    readCourse: async () => ({
      course: { displayName: "Probability" },
      announcements: [],
      conversations: [],
      items,
    }),
    readAttachments: async (courseId, item) => attachmentsOf(item),
    download: download ?? (async () => ({ body: Buffer.from("pdf"), headers: {} })),
  };
}

const course = (destination) => ({ key: "MH2500", courseId: "_9_1", destination });

// Synced once as `HANDOUTS`, then read back as `REORDERED`: the state a destination is in when a
// course gains an item at the top, which is what this command exists to answer.
async function reordered(items = REORDERED) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-"));
  const state = { version: 1, courses: {} };
  await syncCourse({ client: client(HANDOUTS), course: course(destination), state });
  await syncCourse({ client: client(items), course: course(destination), state });
  return { destination, state, items };
}

async function renumber({ destination, state, items }) {
  return renumberCourse({ client: client(items), course: course(destination), state });
}

test("puts a destination back into the order the course has today", async () => {
  const at = await reordered();

  const result = await renumber(at);

  assert.deepEqual((await readdir(at.destination)).sort(), [
    "01 Tutorial 01.pdf",
    "02 Hand00.pdf",
    "03 Hand01.pdf",
    "Course.md",
    "Last synced.md",
  ]);
  assert.deepEqual(result.renamed.map(({ from, to }) => `${from} -> ${to}`).sort(), [
    "01 Hand00.pdf -> 02 Hand00.pdf",
    "02 Hand01.pdf -> 03 Hand01.pdf",
  ]);
  assert.ok(!("kept" in result));
});

// A shift looks like it should need an order — each file appearing to want the name of the one
// below it — and it does not. A name is a number *and* a title, so `02 Hand00.pdf` is not the name
// `02 Hand01.pdf` holds, and every rename here is onto a name nothing was using. The bytes are
// checked afterwards because the failure this would have is silent: the right names, wrong files.
test("moves the bytes with the name, in whatever order the walk hands them over", async () => {
  const at = await reordered();

  await renumber(at);

  assert.equal(await readFile(join(at.destination, "02 Hand00.pdf"), "utf8"), "pdf");
  assert.equal(await readFile(join(at.destination, "03 Hand01.pdf"), "utf8"), "pdf");
});

// The whole of what makes a rename safe here. A destination is somebody's own folder, and the file
// they annotated is the one a rename would take out from under their notes (ADR-0003, ADR-0010).
test("leaves a file the student has changed exactly where it is, and says so", async () => {
  const at = await reordered();
  await writeFile(join(at.destination, "01 Hand00.pdf"), "pdf, with my notes on it");

  const result = await renumber(at);

  assert.equal(
    await readFile(join(at.destination, "01 Hand00.pdf"), "utf8"),
    "pdf, with my notes on it",
  );
  assert.deepEqual(result.kept, [
    {
      file: "Hand00.pdf",
      trail: "",
      path: "02 Hand00.pdf",
      onDisk: "01 Hand00.pdf",
      why: "it has changed since the sync wrote it",
    },
  ]);
  assert.equal(result.renamed.length, 1);
});

// `State` is a cache that costs nothing to delete (`CONTEXT.md`), and losing it costs a re-download
// rather than a rename nobody can vouch for. Without a digest there is no evidence, and no evidence
// means the file is not touched.
test("renames nothing it has no recorded digest for", async () => {
  const at = await reordered();

  const result = await renumberCourse({
    client: client(at.items),
    course: course(at.destination),
    state: { version: 1, courses: {} },
  });

  assert.equal(result.renamed.length, 0);
  assert.deepEqual(
    result.kept.map((each) => each.why),
    [
      "no recorded digest, so there is nothing to hold it against",
      "no recorded digest, so there is nothing to hold it against",
    ],
  );
  assert.ok((await readdir(at.destination)).includes("01 Hand00.pdf"));
});

// A document is a pure function of the snapshot, so the walk is holding what the sync would write
// and the text on disk is evidence in its own right — no record needed, and no digest to lose.
const QUIZ = {
  id: "_4_1",
  parentId: null,
  position: 0,
  title: "Knowledge Check",
  contentHandler: "resource/x-bb-asmt-test-link",
};

test("holds a document against the text the walk produced rather than against a record", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-"));
  const state = { version: 1, courses: {} };
  const moved = [TUTORIAL, { ...QUIZ, position: 1 }];
  await syncCourse({ client: client([QUIZ]), course: course(destination), state });
  await syncCourse({ client: client(moved), course: course(destination), state });

  // No record was ever written for a document, so a digest could not have carried this one.
  const result = await renumberCourse({
    client: client(moved),
    course: course(destination),
    state: { version: 1, courses: {} },
  });

  assert.deepEqual((await readdir(destination)).sort(), [
    "01 Tutorial 01.pdf",
    "02 Knowledge Check.md",
    "Course.md",
    "Last synced.md",
  ]);
  assert.equal(result.renamed.length, 1);
});

// A folder's name carries its position too. It is placed rather than filed, so it has no `file` or
// `path` of its own — reaching for one crashed the command mid-run against `MH2100`, after it had
// renamed two files and before it reached the first folder (#74).
const WEEK = (position, extra = []) => [
  { id: "_5_1", parentId: null, position, title: "Week 1", contentHandler: "resource/x-bb-folder" },
  handout("_6_1", 0, "Slides", "_5_1"),
  ...extra,
];

async function withFolder(items) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-"));
  const state = { version: 1, courses: {} };
  await syncCourse({ client: client(WEEK(0)), course: course(destination), state });
  return { destination, state, items };
}

test("renames a folder whose own number moved, and carries its files with it", async () => {
  const at = await withFolder(WEEK(1));

  const result = await renumber(at);

  assert.deepEqual((await readdir(at.destination)).sort(), [
    "02 Week 1",
    "Course.md",
    "Last synced.md",
  ]);
  assert.deepEqual(await readdir(join(at.destination, "02 Week 1")), ["01 Slides.pdf"]);
  assert.deepEqual(
    result.renamed.map(({ from, to }) => `${from} -> ${to}`),
    ["01 Week 1 -> 02 Week 1"],
  );
  assert.equal(result.renamed[0].file, "Week 1");
});

// The file inside it is at a path that has moved while its own name is already right, so there is
// nothing to do to it. Counting it as a candidate made it ask for the name it already had, which
// `link` refuses — and it was reported `blocked`, reddening a run that had done nothing wrong.
test("says nothing about a file whose folder moved but whose own number did not", async () => {
  const at = await withFolder(WEEK(1));

  const result = await renumber(at);

  assert.equal(result.renamed.length, 1);
  assert.ok(!("blocked" in result));
  assert.ok(!("kept" in result));
});

// The limitation worth knowing rather than discovering. A destination synced before #70 has an
// empty folder standing at the number the real one wants, and the lookup answers with that empty
// folder because a directory *is* there — so the course stays in the folder it is in and this
// command has nothing to say. It is untidy and it takes nothing away, which is ADR-0003's trade.
test("leaves a course alone where an empty folder already holds the number it wants", async () => {
  const at = await withFolder(WEEK(1));
  await mkdir(join(at.destination, "02 Week 1"));

  const result = await renumber(at);

  assert.deepEqual((await readdir(at.destination)).sort(), [
    "01 Week 1",
    "02 Week 1",
    "Course.md",
    "Last synced.md",
  ]);
  assert.deepEqual(await readdir(join(at.destination, "01 Week 1")), ["01 Slides.pdf"]);
  assert.deepEqual(await readdir(join(at.destination, "02 Week 1")), []);
  assert.deepEqual(result.renamed, []);
  assert.ok(!("blocked" in result));
  assert.equal(renumberReport([result]).renamed, 0);
});

// A run over a destination the course has not moved under is a run with nothing to say.
test("says nothing about a destination already in the course's order", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-"));
  const state = { version: 1, courses: {} };
  await syncCourse({ client: client(REORDERED), course: course(destination), state });

  const result = await renumberCourse({
    client: client(REORDERED),
    course: course(destination),
    state,
  });

  assert.deepEqual(result.renamed, []);
  assert.ok(!("kept" in result));
  assert.ok(!("blocked" in result));
  assert.equal(renumberReport([result]).renamed, 0);
});
