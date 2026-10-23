import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentsOf } from "../src/ntulearn/content.mjs";
import { syncCourse } from "../src/sync/course.mjs";
import { renumberCourse, renumberReport } from "../src/sync/renumber.mjs";
import { fileDigest } from "../src/sync/files.mjs";
import { verifyCourse } from "../src/sync/verify.mjs";

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
    "Source editions",
    "Sync status.json",
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
    "Source editions",
    "Sync status.json",
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
    "Source editions",
    "Sync status.json",
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
    "Source editions",
    "Sync status.json",
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

async function reversibleFixture(t) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-reversal-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const state = { version: 1, courses: {} };
  const source = client(HANDOUTS, async (attachment) => ({
    body: Buffer.from(`distinct attachment ${attachment.resourceUrl}`),
    headers: {},
  }));
  await syncCourse({ client: source, course: course(destination), state });
  await writeFile(join(destination, "Student notes.md"), "My own unchanged notes");
  const before = await directoryDigests(destination);
  const stateBefore = JSON.stringify(state);
  const shifted = HANDOUTS.map((item) => ({ ...item, position: item.position + 1 }));
  const forward = await renumber({ destination, state, items: shifted });
  assert.deepEqual(
    forward.renamed.map(({ from, to }) => ({ from, to })),
    [
      { from: "01 Hand00.pdf", to: "02 Hand00.pdf" },
      { from: "02 Hand01.pdf", to: "03 Hand01.pdf" },
    ],
  );
  assert.notEqual(before["01 Hand00.pdf"], before["02 Hand01.pdf"]);
  for (const { from, to } of forward.renamed)
    assert.equal(await fileDigest(join(destination, to)), before[from]);
  return { destination, state, before, stateBefore };
}

async function directoryDigests(destination) {
  const values = {};
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = prefix + name,
        info = await lstat(path);
      if (info.isDirectory()) await visit(path, key + "/");
      else values[key] = await fileDigest(path);
    }
  }
  await visit(destination);
  return values;
}

test("original snapshot reverses attachment numbering with distinct bytes, notes and state intact", async (t) => {
  const at = await reversibleFixture(t);
  const inverse = await renumber({ ...at, items: HANDOUTS });
  assert.deepEqual(
    inverse.renamed.map(({ from, to }) => ({ from, to })),
    [
      { from: "02 Hand00.pdf", to: "01 Hand00.pdf" },
      { from: "03 Hand01.pdf", to: "02 Hand01.pdf" },
    ],
  );
  assert.deepEqual(await directoryDigests(at.destination), at.before);
  assert.equal(JSON.stringify(at.state), at.stateBefore);
  assert.ok(!("blocked" in inverse));
  assert.ok(!("kept" in inverse));
});

test("inverse numbering refuses an attachment edited after the forward operation", async (t) => {
  const at = await reversibleFixture(t);
  const edited = join(at.destination, "03 Hand01.pdf");
  await writeFile(edited, "Student annotations made after renumbering");
  const editedHash = await fileDigest(edited);
  const inverse = await renumber({ ...at, items: HANDOUTS });
  assert.equal(inverse.renamed.length, 1);
  assert.equal(inverse.kept[0].onDisk, "03 Hand01.pdf");
  assert.match(inverse.kept[0].why, /changed since the sync wrote/);
  assert.equal(await fileDigest(edited), editedHash);
  assert.equal(await fileDigest(join(at.destination, "02 Hand01.pdf")), null);
  assert.equal(await fileDigest(join(at.destination, "01 Hand00.pdf")), at.before["01 Hand00.pdf"]);
  assert.equal(
    await fileDigest(join(at.destination, "Student notes.md")),
    at.before["Student notes.md"],
  );
  assert.equal(JSON.stringify(at.state), at.stateBefore);
});

test("inverse numbering reports an occupied target and preserves its student contents", async (t) => {
  const at = await reversibleFixture(t);
  const occupied = join(at.destination, "01 Hand00.pdf");
  await mkdir(occupied);
  const studentFile = join(occupied, "Student file.md");
  await writeFile(studentFile, "Student bytes at the original attachment name");
  const studentHash = await fileDigest(studentFile);
  const inverse = await renumber({ ...at, items: HANDOUTS });
  assert.equal(inverse.renamed.length, 1);
  assert.deepEqual(
    inverse.blocked.map(({ from, to, why }) => ({ from, to, why })),
    [
      {
        from: "02 Hand00.pdf",
        to: "01 Hand00.pdf",
        why: "the name it wants is held by something else",
      },
    ],
  );
  assert.equal(await fileDigest(join(at.destination, "02 Hand00.pdf")), at.before["01 Hand00.pdf"]);
  assert.equal(await fileDigest(studentFile), studentHash);
  assert.equal(await fileDigest(join(at.destination, "02 Hand01.pdf")), at.before["02 Hand01.pdf"]);
  assert.equal(
    await fileDigest(join(at.destination, "Student notes.md")),
    at.before["Student notes.md"],
  );
  assert.equal(JSON.stringify(at.state), at.stateBefore);
});

const digest = (body) => createHash("sha256").update(body).digest("hex");
const revisionAttachment = {
  id: "stable-file",
  fileName: "Guide.pdf",
  resourceUrl: "/bbcswebdav/guide",
};

function revisionClient(revision, position = 0, files = [revisionAttachment]) {
  return {
    ...client([
      {
        id: "guide",
        title: "Guide",
        position,
        modifiedDate: `2026-10-0${revision}T00:00:00Z`,
        contentHandler: "resource/x-bb-file",
      },
    ]),
    readAttachments: async () => files,
    download: async () => ({ body: Buffer.from(`PDF ${revision}`), headers: {} }),
  };
}

async function revisionFixture(t, revisions = 2, files = [revisionAttachment]) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-editions-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const state = { courses: {} };
  for (let revision = 1; revision <= revisions; revision++) {
    const result = await syncCourse({
      client: revisionClient(revision, 0, files),
      course: course(destination),
      state,
    });
    assert.equal(result.failures.length, 0);
  }
  const current = (await readdir(destination)).find((name) =>
    name.includes(`revision ${digest(`PDF ${revisions}`).slice(0, 24)}`),
  );
  const source = revisionClient(revisions, 1, files);
  source.download = async () => assert.fail("renumber and current-revision reuse cannot fetch");
  return { destination, state, current, source };
}

async function editionRecords(destination) {
  const root = join(destination, "Source editions");
  const [identity] = await readdir(root);
  const directory = join(root, identity);
  const records = await Promise.all(
    (await readdir(directory)).map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
  );
  return { directory, records };
}

async function addRecord(directory, record) {
  const body = JSON.stringify(record) + "\n";
  await writeFile(join(directory, digest(body) + ".json"), body);
}

test("renumbers only the current attachment edition and round-trips without copies", async (t) => {
  const at = await revisionFixture(t, 3, [
    { ...revisionAttachment, fileName: "資料".repeat(25) + ".pdf" },
  ]);
  at.source.readAttachments = async () => [
    { ...revisionAttachment, fileName: "New upstream filename.pdf" },
  ];
  const older = (await readdir(at.destination)).filter(
    (name) => name.endsWith(".pdf") && name !== at.current,
  );
  for (const name of older) await writeFile(join(at.destination, name), `Student notes in ${name}`);
  const before = await directoryDigests(at.destination);
  const stateBefore = JSON.stringify(at.state);
  const renamed = at.current.replace(/^01 /, "02 ");

  const result = await renumberCourse({
    client: at.source,
    course: course(at.destination),
    state: at.state,
  });

  assert.deepEqual(
    result.renamed.map(({ from, to }) => ({ from, to })),
    [{ from: at.current, to: renamed }],
  );
  assert.ok(!result.kept);
  const after = { ...before, [renamed]: before[at.current] };
  delete after[at.current];
  assert.deepEqual(await directoryDigests(at.destination), after);
  assert.equal(JSON.stringify(at.state), stateBefore);
  const verified = await verifyCourse({ client: at.source, course: course(at.destination) });
  assert.deepEqual(verified.missing, []);
  assert.ok(!verified.renumbered);
  assert.deepEqual(
    (await renumberCourse({ client: at.source, course: course(at.destination), state: at.state }))
      .renamed,
    [],
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    const synced = await syncCourse({
      client: at.source,
      course: course(at.destination),
      state: at.state,
    });
    assert.equal(synced.failures.length, 0);
    assert.equal(synced.newEditions, 0);
    assert.equal(synced.downloaded, 0);
    assert.deepEqual(
      (await renumberCourse({ client: at.source, course: course(at.destination), state: at.state }))
        .renamed,
      [],
    );
    const files = await directoryDigests(at.destination);
    assert.deepEqual(
      Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith(".pdf"))),
      Object.fromEntries(Object.entries(after).filter(([path]) => path.endsWith(".pdf"))),
    );
  }
});

test("later reorders recover one edition after all equivalent recorded paths disappear", async (t) => {
  const at = await revisionFixture(t);
  for (const position of [1, 2, 3]) {
    const source = revisionClient(2, position);
    source.download = async () => assert.fail("the recorded current revision must be reused");
    const renamed = await renumberCourse({
      client: source,
      course: course(at.destination),
      state: at.state,
    });
    assert.equal(renamed.renamed.length, 1);
    const verified = await verifyCourse({ client: source, course: course(at.destination) });
    assert.deepEqual(verified.missing, []);
    assert.ok(!verified.renumbered);
    const result = await syncCourse({
      client: source,
      course: course(at.destination),
      state: at.state,
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.newEditions, 0);
    assert.equal((await readdir(at.destination)).filter((name) => name.endsWith(".pdf")).length, 2);
  }
});

test("attachment editions still require compatible State evidence", async (t) => {
  for (const refusal of ["missing", "digest", "identity"]) {
    await t.test(refusal, async (t) => {
      const at = await revisionFixture(t);
      const record = Object.values(at.state.courses.MH2500.downloads)[0];
      if (refusal === "missing") at.state = { courses: {} };
      if (refusal === "digest") record.sha256 = digest("PDF 1");
      if (refusal === "identity") record.sourceIdentity = "a".repeat(64);
      const before = await directoryDigests(at.destination);
      const stateBefore = JSON.stringify(at.state);
      const result = await renumberCourse({
        client: at.source,
        course: course(at.destination),
        state: at.state,
      });
      assert.deepEqual(result.renamed, []);
      assert.equal(result.kept.length, 1);
      assert.equal(result.kept[0].onDisk, at.current);
      assert.match(result.kept[0].why, refusal === "missing" ? /no recorded digest/ : /State/);
      assert.deepEqual(await directoryDigests(at.destination), before);
      assert.equal(JSON.stringify(at.state), stateBefore);
    });
  }
});

test("edited current attachment edition stays at its held name", async (t) => {
  const at = await revisionFixture(t);
  await writeFile(join(at.destination, at.current), "Student annotation");
  const before = await directoryDigests(at.destination);
  const result = await renumberCourse({
    client: at.source,
    course: course(at.destination),
    state: at.state,
  });
  assert.deepEqual(result.renamed, []);
  assert.equal(result.kept[0].onDisk, at.current);
  assert.match(result.kept[0].why, /changed since the sync wrote/);
  assert.deepEqual(await directoryDigests(at.destination), before);
});

test("unresolved current attachment never falls back to its historical original", async (t) => {
  for (const refusal of [
    "fingerprint",
    "identity",
    "missing identity",
    "legacy",
    "revision",
    "placement",
  ]) {
    await t.test(refusal, async (t) => {
      const at = await revisionFixture(t);
      if (refusal === "fingerprint") at.source = revisionClient(3, 1);
      if (refusal === "identity")
        at.source = revisionClient(2, 1, [revisionAttachment, revisionAttachment]);
      if (refusal === "missing identity")
        at.source = revisionClient(2, 1, [
          { fileName: "Guide.pdf", resourceUrl: "/download?id=missing" },
        ]);
      const { directory, records } = await editionRecords(at.destination);
      const current = records.find((record) => record.sha256 === digest("PDF 2"));
      if (refusal === "legacy") {
        await rm(directory, { recursive: true });
        await mkdir(directory);
        const legacy = { ...current, schemaVersion: 1, version: null };
        delete legacy.fingerprint;
        await addRecord(directory, legacy);
      }
      if (refusal === "revision")
        await addRecord(directory, {
          ...current,
          version: digest("CONFLICTING REVISION"),
          sha256: digest("CONFLICTING REVISION"),
        });
      if (refusal === "placement") {
        const alternate = at.current.replace(/^01 /, "03 ");
        await copyFile(join(at.destination, at.current), join(at.destination, alternate));
        await addRecord(directory, { ...current, relativePath: alternate });
      }
      at.source.download = async () => assert.fail("unresolved sources cannot fetch for renumber");
      const before = await directoryDigests(at.destination);
      const result = await renumberCourse({
        client: at.source,
        course: course(at.destination),
        state: at.state,
      });
      assert.deepEqual(result.renamed, []);
      assert.ok(result.kept.length > 0);
      assert.ok(
        result.kept.every((entry) => /source|revision|placement|identity/i.test(entry.why)),
      );
      assert.ok(result.kept.every((entry) => !entry.onDisk));
      assert.deepEqual(await directoryDigests(at.destination), before);
    });
  }
});

test("malformed provenance refuses before any renumbering", async (t) => {
  const at = await revisionFixture(t);
  const { directory } = await editionRecords(at.destination);
  await writeFile(join(directory, "malformed.json"), "{}");
  const before = await directoryDigests(at.destination);
  await assert.rejects(
    renumberCourse({ client: at.source, course: course(at.destination), state: at.state }),
    /provenance is malformed/,
  );
  assert.deepEqual(await directoryDigests(at.destination), before);
});

test("missing recorded placement requires a unique numbered fallback", async (t) => {
  const at = await revisionFixture(t);
  const second = at.current.replace(/^01 /, "02 ");
  const third = at.current.replace(/^01 /, "03 ");
  await rename(join(at.destination, at.current), join(at.destination, second));
  await copyFile(join(at.destination, second), join(at.destination, third));
  const before = await directoryDigests(at.destination);
  const result = await renumberCourse({
    client: at.source,
    course: course(at.destination),
    state: at.state,
  });
  assert.deepEqual(result.renamed, []);
  assert.match(result.kept[0].why, /ambiguous.*placement|placement.*ambiguous/);
  assert.ok(!result.kept[0].onDisk);
  const verified = await verifyCourse({ client: at.source, course: course(at.destination) });
  assert.equal(verified.missing.length, 1);
  assert.deepEqual(await directoryDigests(at.destination), before);
});

test("a nonregular stale name does not hide the uniquely proven current attachment", async (t) => {
  const at = await revisionFixture(t);
  const alternate = at.current.replace(/^01 /, "03 ");
  await rename(join(at.destination, at.current), join(at.destination, alternate));
  await mkdir(join(at.destination, at.current));
  await writeFile(join(at.destination, at.current, "Student.md"), "Student directory");
  const before = await directoryDigests(at.destination);
  const result = await renumberCourse({
    client: at.source,
    course: course(at.destination),
    state: at.state,
  });
  const target = at.current.replace(/^01 /, "02 ");
  assert.deepEqual(
    result.renamed.map(({ from, to }) => ({ from, to })),
    [{ from: alternate, to: target }],
  );
  const after = { ...before, [target]: before[alternate] };
  delete after[alternate];
  assert.deepEqual(await directoryDigests(at.destination), after);
});

test("different recorded stems remain ambiguous even when only one numbered file remains", async (t) => {
  const at = await revisionFixture(t);
  const { directory, records } = await editionRecords(at.destination);
  const current = records.find((record) => record.sha256 === digest("PDF 2"));
  await addRecord(directory, {
    ...current,
    relativePath: current.relativePath.replace("Guide", "Other"),
  });
  await rename(
    join(at.destination, at.current),
    join(at.destination, at.current.replace(/^01 /, "03 ")),
  );
  const before = await directoryDigests(at.destination);
  const result = await renumberCourse({
    client: at.source,
    course: course(at.destination),
    state: at.state,
  });
  assert.deepEqual(result.renamed, []);
  assert.match(result.kept[0].why, /placement is ambiguous/);
  assert.deepEqual(await directoryDigests(at.destination), before);
});

test("distinct colliding identities renumber their editions and retain the unproven original", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-collisions-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await writeFile(join(destination, "01 Guide.pdf"), "Student original");
  const state = { courses: {} };
  const files = ["one", "two"].map((id) => ({
    id,
    fileName: "Guide.pdf",
    resourceUrl: `/bbcswebdav/${id}`,
  }));
  const first = revisionClient(1, 0, files);
  first.download = async (file) => ({ body: Buffer.from(file.resourceUrl), headers: {} });
  const synced = await syncCourse({ client: first, course: course(destination), state });
  assert.deepEqual(synced.failures, []);
  const editions = (await readdir(destination)).filter((name) => name.includes("[source"));
  const source = revisionClient(1, 1, files);
  source.download = async () => assert.fail("renumber cannot download colliding identities");
  const result = await renumberCourse({ client: source, course: course(destination), state });
  assert.deepEqual(
    result.renamed
      .map(({ from, to }) => ({ from, to }))
      .sort((a, b) => a.from.localeCompare(b.from)),
    editions.sort().map((from) => ({ from, to: from.replace(/^01 /, "02 ") })),
  );
  assert.equal(await readFile(join(destination, "01 Guide.pdf"), "utf8"), "Student original");
  const verified = await verifyCourse({ client: source, course: course(destination) });
  assert.deepEqual(verified.missing, []);
  assert.ok(!verified.renumbered);
});

test("distinct content items sharing an attachment URL keep independent renumber evidence", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-shared-url-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const state = { courses: {} };
  const items = HANDOUTS.map((each) => ({
    ...each,
    contentDetail: {
      "resource/x-bb-file": {
        file: { fileName: "Shared.pdf", permanentUrl: "/bbcswebdav/shared" },
      },
    },
  }));
  const later = items.map((each) => ({ ...each, position: each.position + 2 }));
  const first = client(items);
  const current = client(later, async () => assert.fail("unchanged sources must not download"));
  assert.deepEqual(
    (await syncCourse({ client: first, course: course(destination), state })).failures,
    [],
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    const synced = await syncCourse({ client: current, course: course(destination), state });
    assert.deepEqual(synced.failures, []);
    assert.equal(synced.downloaded, 0);
    assert.equal(synced.newEditions, 0);
  }
  const before = await directoryDigests(destination);
  const refused = await renumberCourse({
    client: current,
    course: course(destination),
    state: { courses: {} },
  });
  assert.deepEqual(refused.renamed, []);
  assert.equal(refused.kept.length, 2);
  assert.ok(refused.kept.every((each) => /no recorded digest/.test(each.why)));
  assert.deepEqual(await directoryDigests(destination), before);
  const stateBefore = JSON.stringify(state);
  const result = await renumberCourse({ client: current, course: course(destination), state });
  assert.deepEqual(
    result.renamed.map(({ from, to }) => ({ from, to })),
    [
      { from: "01 Shared.pdf", to: "03 Shared.pdf" },
      { from: "02 Shared.pdf", to: "04 Shared.pdf" },
    ],
  );
  assert.ok(!result.kept);
  assert.ok(!result.blocked);
  assert.equal(JSON.stringify(state), stateBefore);
  for (const { from, to } of result.renamed)
    assert.equal(await fileDigest(join(destination, to)), before[from]);
  const verified = await verifyCourse({ client: current, course: course(destination) });
  assert.deepEqual(verified.missing, []);
  assert.ok(!verified.renumbered);
  for (let repeat = 0; repeat < 2; repeat++) {
    const synced = await syncCourse({ client: current, course: course(destination), state });
    assert.deepEqual(synced.failures, []);
    assert.equal(synced.downloaded, 0);
    assert.equal(synced.newEditions, 0);
    assert.deepEqual((await readdir(destination)).filter((name) => name.endsWith(".pdf")).sort(), [
      "03 Shared.pdf",
      "04 Shared.pdf",
    ]);
    assert.equal(await fileDigest(join(destination, "03 Shared.pdf")), before["01 Shared.pdf"]);
    assert.equal(await fileDigest(join(destination, "04 Shared.pdf")), before["02 Shared.pdf"]);
  }
});

test("exact recorded edition keeps authority when its desired name is occupied", async (t) => {
  for (const occupant of ["file", "directory", "symlink"]) {
    await t.test(occupant, async (t) => {
      const at = await revisionFixture(t);
      const targetName = at.current.replace(/^01 /, "02 ");
      const target = join(at.destination, targetName);
      const marker = join(at.destination, "Student notes.md");
      await writeFile(marker, "Student bytes");
      if (occupant === "file") await writeFile(target, "Occupied bytes");
      if (occupant === "directory") await mkdir(target);
      if (occupant === "symlink") await symlink(marker, target);
      const currentBefore = await fileDigest(join(at.destination, at.current));
      const result = await renumberCourse({
        client: at.source,
        course: course(at.destination),
        state: at.state,
      });
      assert.deepEqual(result.renamed, []);
      assert.deepEqual(
        result.blocked.map(({ from, to }) => ({ from, to })),
        [{ from: at.current, to: targetName }],
      );
      assert.equal(await fileDigest(join(at.destination, at.current)), currentBefore);
      assert.equal(await readFile(marker, "utf8"), "Student bytes");
      if (occupant === "file") assert.equal(await readFile(target, "utf8"), "Occupied bytes");
      if (occupant === "directory") assert.deepEqual(await readdir(target), []);
      if (occupant === "symlink") assert.ok((await lstat(target)).isSymbolicLink());
    });
  }
});

function pageClient(body, parentPosition = 0, position = 0) {
  return {
    ...client([
      {
        id: "folder",
        title: "Folder",
        position: parentPosition,
        contentHandler: "resource/x-bb-folder",
      },
      {
        id: "page",
        parentId: "folder",
        title: "Page",
        position,
        contentHandler: "resource/x-bb-document",
        body: { rawText: body },
      },
    ]),
    readAttachments: async () => [],
    download: async () => assert.fail("pages have no attachment download"),
  };
}

async function pageFixture(t) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-renumber-page-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const state = { courses: {} };
  for (const body of ["First", "Second"]) {
    const result = await syncCourse({
      client: pageClient(body),
      course: course(destination),
      state,
    });
    assert.equal(result.failures.length, 0);
  }
  const current = (await readdir(join(destination, "01 Folder"))).find((name) =>
    name.includes("[source"),
  );
  return { destination, state, current };
}

test("current page editions retain complete bytes through leaf and parent renumbering", async (t) => {
  for (const leafPosition of [0, 1]) {
    await t.test(leafPosition ? "leaf and parent" : "parent only", async (t) => {
      const at = await pageFixture(t);
      const source = pageClient("Second", 1, leafPosition);
      await writeFile(
        join(at.destination, "01 Folder", "01 Page.md"),
        "Student original page notes",
      );
      const before = await directoryDigests(at.destination);
      const stateBefore = JSON.stringify(at.state);
      const oldPath = `01 Folder/${at.current}`;
      const newPath = `02 Folder/${at.current.replace(/^01 /, leafPosition ? "02 " : "01 ")}`;
      const result = await renumberCourse({
        client: source,
        course: course(at.destination),
        state: at.state,
      });
      assert.equal(result.renamed.length, leafPosition ? 2 : 1);
      if (leafPosition)
        assert.deepEqual(
          result.renamed.map(({ from, to }) => ({ from, to })),
          [
            { from: oldPath, to: newPath },
            { from: "01 Folder", to: "02 Folder" },
          ],
        );
      assert.ok(!result.kept);
      assert.ok(!result.blocked);
      assert.equal(await fileDigest(join(at.destination, newPath)), before[oldPath]);
      assert.equal(
        await fileDigest(join(at.destination, "02 Folder", "01 Page.md")),
        before["01 Folder/01 Page.md"],
      );
      assert.equal(JSON.stringify(at.state), stateBefore);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(await directoryDigests(at.destination)).filter(([path]) =>
            path.startsWith("Source editions/"),
          ),
        ),
        Object.fromEntries(
          Object.entries(before).filter(([path]) => path.startsWith("Source editions/")),
        ),
      );
      const verified = await verifyCourse({ client: source, course: course(at.destination) });
      assert.deepEqual(verified.missing, []);
      assert.ok(!verified.renumbered);
      assert.deepEqual(
        (await renumberCourse({ client: source, course: course(at.destination), state: at.state }))
          .renamed,
        [],
      );
      for (let repeat = 0; repeat < 2; repeat++) {
        const synced = await syncCourse({
          client: source,
          course: course(at.destination),
          state: at.state,
        });
        assert.deepEqual(synced.failures, []);
        assert.equal(synced.newEditions, 0);
        assert.equal(synced.markdownWritten, 0);
        assert.deepEqual(
          (await readdir(join(at.destination, "02 Folder"))).sort(),
          ["01 Page.md", newPath.split("/").at(-1)].sort(),
        );
        assert.equal(await fileDigest(join(at.destination, newPath)), before[oldPath]);
      }
      const later = pageClient("Second", 2, leafPosition ? 2 : 0);
      const laterRenumber = await renumberCourse({
        client: later,
        course: course(at.destination),
        state: at.state,
      });
      assert.equal(laterRenumber.renamed.length, leafPosition ? 2 : 1);
      const laterVerified = await verifyCourse({ client: later, course: course(at.destination) });
      assert.deepEqual(laterVerified.missing, []);
      assert.ok(!laterVerified.renumbered);
      const laterSynced = await syncCourse({
        client: later,
        course: course(at.destination),
        state: at.state,
      });
      assert.deepEqual(laterSynced.failures, []);
      assert.equal(laterSynced.newEditions, 0);
      assert.equal(
        await fileDigest(
          join(
            at.destination,
            "03 Folder",
            at.current.replace(/^01 /, leafPosition ? "03 " : "01 "),
          ),
        ),
        before[oldPath],
      );
    });
  }
});

test("edited current page edition refuses movement while its parent can move", async (t) => {
  const at = await pageFixture(t);
  await writeFile(join(at.destination, "01 Folder", at.current), "Student page annotation");
  const result = await renumberCourse({
    client: pageClient("Second", 1, 1),
    course: course(at.destination),
    state: { courses: {} },
  });
  assert.deepEqual(
    result.renamed.map(({ from, to }) => ({ from, to })),
    [{ from: "01 Folder", to: "02 Folder" }],
  );
  assert.equal(result.kept[0].onDisk, `02 Folder/${at.current}`);
  assert.match(result.kept[0].why, /changed since the sync wrote/);
  assert.equal(
    await readFile(join(at.destination, result.kept[0].onDisk), "utf8"),
    "Student page annotation",
  );
});

test("child rename reports its actual parent when the desired parent is occupied", async (t) => {
  const at = await pageFixture(t);
  await mkdir(join(at.destination, "02 Folder"));
  await writeFile(join(at.destination, "02 Folder", "Student.md"), "Student folder");
  const result = await renumberCourse({
    client: pageClient("Second", 1, 1),
    course: course(at.destination),
    state: { courses: {} },
  });
  assert.deepEqual(
    result.renamed.map(({ from, to }) => ({ from, to })),
    [{ from: `01 Folder/${at.current}`, to: `01 Folder/${at.current.replace(/^01 /, "02 ")}` }],
  );
  assert.equal(
    await readFile(join(at.destination, "02 Folder", "Student.md"), "utf8"),
    "Student folder",
  );
});
