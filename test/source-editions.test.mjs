import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCourse } from "../src/sync/course.mjs";
import { verifyCourse } from "../src/sync/verify.mjs";
const item = { id: "item", title: "Files", position: 0, contentHandler: "resource/x-bb-file" };
const attachments = [
  { resourceUrl: "/bbcswebdav/one", fileName: "Quiz:1.pdf" },
  { resourceUrl: "/bbcswebdav/two", fileName: "quiz?1.pdf" },
];
async function fixture(fn) {
  const destination = await mkdtemp(join(tmpdir(), "source-editions-"));
  try {
    await fn({ key: "SYNTHETIC", courseId: "synthetic", destination });
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
function reader(files = attachments, announcements = []) {
  return {
    readCourse: async () => ({
      course: { displayName: "Synthetic" },
      items: files.length ? [item] : [],
      announcements,
      conversations: [],
    }),
    readAttachments: async () => files,
    download: async (file) => ({ body: Buffer.from(file.resourceUrl), headers: {} }),
  };
}
test("colliding sources publish distinct stable names through reorder and state loss", () =>
  fixture(async (course) => {
    const state = { courses: {} };
    let result = await syncCourse({ client: reader(), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloaded, 2);
    const before = await readdir(course.destination);
    assert.equal(before.filter((n) => n.endsWith(".pdf")).length, 2);
    assert.equal((await verifyCourse({ client: reader(), course })).missing.length, 0);
    result = await syncCourse({
      client: reader([...attachments].reverse()),
      course,
      state: { courses: {} },
    });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(await readdir(course.destination), before);
  }));
test("later and removed siblings never redirect a recorded source", () =>
  fixture(async (course) => {
    const state = { courses: {} };
    await syncCourse({ client: reader([attachments[0]]), course, state });
    const original = (await readdir(course.destination)).find((n) => n.endsWith(".pdf"));
    let result = await syncCourse({ client: reader(), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(
      await readFile(join(course.destination, original), "utf8"),
      attachments[0].resourceUrl,
    );
    assert.equal((await verifyCourse({ client: reader(), course })).missing.length, 0);
    const before = (await readdir(course.destination)).filter((n) => n.endsWith(".pdf"));
    result = await syncCourse({ client: reader([attachments[1]]), course, state });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(
      (await readdir(course.destination)).filter((n) => n.endsWith(".pdf")),
      before,
    );
  }));
test("legacy ambiguous file preserved, edited identity placement refuses publication", () =>
  fixture(async (course) => {
    const legacy = join(course.destination, "01 Quiz_1.pdf");
    await writeFile(legacy, "USER");
    const state = { courses: {} };
    await syncCourse({ client: reader(), course, state });
    assert.equal(await readFile(legacy, "utf8"), "USER");
    const edition = (await readdir(course.destination)).find((n) => n.includes("[source"));
    await writeFile(join(course.destination, edition), "EDIT");
    const result = await syncCourse({ client: reader(), course, state });
    assert.ok(result.failures.length);
    assert.equal(await readFile(join(course.destination, edition), "utf8"), "EDIT");
  }));
test("announcement revisions retain originals and edited editions, identical repeats reuse", () =>
  fixture(async (course) => {
    const announcement = {
      id: "notice",
      title: "Notice",
      createdDate: "2026-01-01T01:00:00Z",
      body: { rawText: "First" },
    };
    const state = { courses: {} };
    await syncCourse({ client: reader([], [announcement]), course, state });
    const directory = join(course.destination, "Announcements");
    const original = (await readdir(directory))[0];
    await writeFile(join(directory, original), "USER EDIT");
    const updated = { ...announcement, body: { rawText: "Second" } };
    let result = await syncCourse({ client: reader([], [updated]), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEditions, 1);
    const before = await readdir(directory);
    assert.equal(before.length, 2);
    assert.equal(await readFile(join(directory, original), "utf8"), "USER EDIT");
    assert.equal((await verifyCourse({ client: reader([], [updated]), course })).missing.length, 0);
    result = await syncCourse({ client: reader([], [updated]), course, state });
    assert.equal(result.newEditions, 0);
    assert.deepEqual(await readdir(directory), before);
    const edition = before.find((n) => n !== original);
    await writeFile(join(directory, edition), "EDITION EDIT");
    result = await syncCourse({ client: reader([], [updated]), course, state });
    assert.ok(result.failures.length);
    assert.equal(await readFile(join(directory, edition), "utf8"), "EDITION EDIT");
  }));

test("one item acquires changed page and attachment as immutable editions", () =>
  fixture(async (course) => {
    const state = { courses: {} };
    const file = { id: "stable-file", fileName: "Guide.pdf", resourceUrl: "/bbcswebdav/guide" };
    const page = { ...item, contentHandler: "resource/x-bb-document", body: { rawText: "First" } };
    const current = reader([file]);
    current.readCourse = async () => ({
      course: { displayName: "Synthetic" },
      items: [page],
      announcements: [],
      conversations: [],
    });
    current.download = async () => ({ body: Buffer.from("PDF ONE"), headers: {} });
    let result = await syncCourse({ client: current, course, state });
    assert.equal(result.failures.length, 0);
    const originalPage = join(course.destination, "01 Files.md");
    const originalFile = join(course.destination, "01 Guide.pdf");
    const firstPage = await readFile(originalPage);
    const firstFile = await readFile(originalFile);
    const updated = {
      ...current,
      readCourse: async () => ({
        course: { displayName: "Synthetic" },
        items: [{ ...page, body: { rawText: "Second" }, modifiedDate: "2026-10-10T00:00:00Z" }],
        announcements: [],
        conversations: [],
      }),
      download: async () => ({ body: Buffer.from("PDF TWO"), headers: {} }),
    };
    assert.equal((await verifyCourse({ client: updated, course })).missing.length, 2);
    result = await syncCourse({ client: updated, course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEditions, 2);
    assert.deepEqual(await readFile(originalPage), firstPage);
    assert.deepEqual(await readFile(originalFile), firstFile);
    const editions = (await readdir(course.destination)).filter((name) => name.includes("[source"));
    assert.equal(editions.length, 2);
    assert.equal((await verifyCourse({ client: updated, course })).missing.length, 0);
    result = await syncCourse({ client: updated, course, state: { courses: {} } });
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEditions, 0);
    assert.deepEqual(
      (await readdir(course.destination)).filter((name) => name.includes("[source")),
      editions,
    );
    const currentFile = join(course.destination, editions.find((name) => name.endsWith(".pdf")));
    await writeFile(currentFile, "STUDENT EDIT");
    result = await syncCourse({ client: updated, course, state });
    assert.equal(result.publicationConflicts, 1);
    assert.equal(await readFile(currentFile, "utf8"), "STUDENT EDIT");
  }));

test("missing and ambiguous attachment identities remain explicit partial failures", () =>
  fixture(async (course) => {
    for (const files of [
      [
        { fileName: "Quiz.pdf", resourceUrl: "/download?id=one" },
        { fileName: "Quiz.pdf", resourceUrl: "/download?id=two" },
      ],
      [
        { id: "same", fileName: "Quiz.pdf", resourceUrl: "/one" },
        { id: "same", fileName: "Quiz.pdf", resourceUrl: "/two" },
      ],
    ]) {
      const result = await syncCourse({ client: reader(files), course, state: { courses: {} } });
      assert.equal(result.unresolvedIdentity, 2);
      assert.equal(result.downloaded, 0);
      assert.equal(result.failures.length, 2);
      assert.equal((await verifyCourse({ client: reader(files), course })).missing.length, 2);
      const receipt = JSON.parse(
        await readFile(join(course.destination, "Sync status.json"), "utf8"),
      );
      assert.equal(receipt.status, "partial");
      assert.equal(receipt.counts.unresolvedIdentity, 2);
    }
  }));
test("checksum evidence refuses equal-size edits when a later collision arrives", () =>
  fixture(async (course) => {
    const state = { courses: {} };
    await syncCourse({ client: reader([attachments[0]]), course, state });
    const original = (await readdir(course.destination)).find((n) => n.endsWith(".pdf"));
    await writeFile(
      join(course.destination, original),
      "x".repeat(attachments[0].resourceUrl.length),
    );
    let calls = 0;
    const client = reader();
    client.download = async (file) => {
      calls++;
      return { body: Buffer.from(file.resourceUrl), headers: {} };
    };
    const result = await syncCourse({ client, course, state });
    assert.equal(result.publicationConflicts, 1);
    assert.equal(calls, 2);
    assert.equal(
      await readFile(join(course.destination, original), "utf8"),
      "x".repeat(attachments[0].resourceUrl.length),
    );
    assert.equal((await readdir(course.destination)).filter((n) => n.endsWith(".pdf")).length, 2);
  }));
test("occupied deterministic suffix refuses replacement and accepts only identical bytes", () =>
  fixture(async (course) => {
    const { expectedFiles } = await import("../src/sync/expected.mjs");
    const { resolveSourceEditions } = await import("../src/sync/source-editions.mjs");
    const client = reader();
    const walked = [];
    for await (const each of expectedFiles({
      client,
      courseId: course.courseId,
      snapshot: await client.readCourse(),
    }))
      walked.push(each);
    const resolved = await resolveSourceEditions({ walked, destination: course.destination });
    const target = resolved.find((each) => each.kind === "attachment").placement.path;
    await writeFile(join(course.destination, target), "OCCUPIED");
    let result = await syncCourse({ client, course, state: { courses: {} } });
    assert.equal(result.publicationConflicts, 1);
    assert.equal(await readFile(join(course.destination, target), "utf8"), "OCCUPIED");
    await writeFile(join(course.destination, target), attachments[0].resourceUrl);
    result = await syncCourse({ client, course, state: { courses: {} } });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloaded, 0);
  }));
test("concurrent identical source publications preserve one immutable edition and retry reuse", () =>
  fixture(async (course) => {
    const results = await Promise.all([
      syncCourse({ client: reader(), course, state: { courses: {} } }),
      syncCourse({ client: reader(), course, state: { courses: {} } }),
    ]);
    assert.ok(results.every((r) => r.failures.length === 0));
    assert.equal(
      results.reduce((n, r) => n + r.downloaded, 0),
      2,
    );
    assert.equal((await readdir(course.destination)).filter((n) => n.endsWith(".pdf")).length, 2);
    const result = await syncCourse({ client: reader(), course, state: { courses: {} } });
    assert.equal(result.newEditions, 0);
    assert.equal(result.downloaded, 0);
  }));
test("long multibyte sanitized names remain bounded and publish", () =>
  fixture(async (course) => {
    const files = attachments.map((a) => ({ ...a, fileName: "題".repeat(150) + ".pdf" }));
    const result = await syncCourse({ client: reader(files), course, state: { courses: {} } });
    assert.equal(result.failures.length, 0);
    for (const name of await readdir(course.destination))
      if (name.endsWith(".pdf")) assert.ok(Buffer.byteLength(name) <= 160);
  }));
test("signed resource addresses are hashed, never retained in state or provenance", () =>
  fixture(async (course) => {
    const files = [
      {
        id: "one",
        fileName: "Quiz.pdf",
        resourceUrl: "https://example.invalid/file?ks=fixture-secret",
      },
      {
        id: "two",
        fileName: "Quiz.pdf",
        resourceUrl: "https://example.invalid/file?ks=other-fixture",
      },
    ];
    const state = { courses: {} };
    const client = reader(files);
    client.download = async () => ({ body: Buffer.from("OWNED"), headers: {} });
    const result = await syncCourse({ client, course, state });
    assert.equal(result.failures.length, 0);
    assert.ok(!JSON.stringify(state).includes("fixture-secret"));
    assert.ok(!JSON.stringify(state).includes("?ks="));
    for (const identity of await readdir(join(course.destination, "Source editions")))
      for (const name of await readdir(join(course.destination, "Source editions", identity)))
        assert.ok(
          !(
            await readFile(join(course.destination, "Source editions", identity, name), "utf8")
          ).includes("fixture-secret"),
        );
  }));

test("explicit renumbering retains existing sources through later sync/verify without old-name copies", () =>
  fixture(async (course) => {
    const { renumberCourse } = await import("../src/sync/renumber.mjs");
    const state = { courses: {} };
    const descriptor = {
      ...attachments[0],
      id: "renumber-source",
      resourceUrl: "https://example.invalid/file?ks=renumber-fixture",
    };
    const first = reader([descriptor]);
    first.download = async () => ({ body: Buffer.from("OWNED"), headers: {} });
    await syncCourse({ client: first, course, state });
    const original = (await readdir(course.destination)).find((n) => n.endsWith(".pdf"));
    const moved = reader([descriptor]);
    moved.readCourse = async () => ({
      course: { displayName: "Synthetic" },
      items: [{ ...item, position: 1 }],
      announcements: [],
      conversations: [],
    });
    const renamed = await renumberCourse({ client: moved, course, state });
    assert.equal(renamed.renamed.length, 1);
    assert.equal((await verifyCourse({ client: moved, course })).missing.length, 0);
    const result = await syncCourse({ client: moved, course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloaded, 0);
    assert.equal((await readdir(course.destination)).filter((n) => n.endsWith(".pdf")).length, 1);
    assert.ok(!(await readdir(course.destination)).includes(original));
    assert.equal((await verifyCourse({ client: moved, course })).missing.length, 0);
  }));

test("initial colliding announcement editions do not invent original links and repeated runs reuse", () =>
  fixture(async (course) => {
    const announcements = ["one", "two"].map((id) => ({
      id,
      title: "Notice",
      createdDate: "2026-01-01T01:00:00Z",
      body: { rawText: id },
    }));
    const state = { courses: {} };
    let result = await syncCourse({ client: reader([], announcements), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEditions, 2);
    const directory = join(course.destination, "Announcements");
    const before = await readdir(directory);
    for (const name of before)
      assert.match(await readFile(join(directory, name), "utf8"), /No original file was recorded/);
    result = await syncCourse({ client: reader([], announcements.reverse()), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.newEditions, 0);
    assert.deepEqual(await readdir(directory), before);
  }));

test("legacy fingerprints migrate without refetch or retaining signed addresses and unknown fields", () =>
  fixture(async (course) => {
    const files = [
      {
        id: "one",
        fileName: "Quiz.pdf",
        resourceUrl: "https://example.invalid/file?ks=legacy-fixture",
      },
    ];
    const state = { courses: {} };
    const client = reader(files);
    let calls = 0;
    client.download = async () => {
      calls++;
      return { body: Buffer.from("OWNED"), headers: {} };
    };
    await syncCourse({ client, course, state });
    const downloads = state.courses.SYNTHETIC.downloads,
      [key] = Object.keys(downloads),
      record = downloads[key];
    delete downloads[key];
    downloads[files[0].resourceUrl] = {
      ...record,
      fingerprint: `::${files[0].resourceUrl}`,
      unknown: "https://example.invalid/?ks=unexpected-fixture",
    };
    const result = await syncCourse({ client, course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(state).includes("?ks="));
    assert.ok(!JSON.stringify(state).includes("unexpected-fixture"));
    assert.match(Object.values(state.courses.SYNTHETIC.downloads)[0].fingerprint, /^[a-f0-9]{64}$/);
  }));

test("upstream colliding renames retain distinct proven paths through sync and verification", () =>
  fixture(async (course) => {
    const sources = [
      { id: "a", fileName: "A.pdf", resourceUrl: "/bbcswebdav/a" },
      { id: "b", fileName: "B.pdf", resourceUrl: "/bbcswebdav/b" },
    ];
    const state = { courses: {} };
    const first = await syncCourse({ client: reader(sources), course, state });
    assert.equal(first.failures.length, 0);
    const originals = (await readdir(course.destination)).filter((name) => name.endsWith(".pdf"));
    const bytes = await Promise.all(
      originals.map((name) => readFile(join(course.destination, name))),
    );
    const renamed = sources.map((source) => ({ ...source, fileName: "Quiz.pdf" })).reverse();
    const result = await syncCourse({ client: reader(renamed), course, state });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloaded, 0);
    assert.equal(result.reusedFiles, 3);
    const verified = await verifyCourse({ client: reader(renamed), course });
    assert.equal(verified.missing.length, 0);
    assert.equal(verified.renumbered.length, 2);
    const stateLost = await syncCourse({ client: reader(renamed), course, state: { courses: {} } });
    assert.equal(stateLost.failures.length, 0);
    assert.equal(stateLost.newEditions, 0);
    assert.deepEqual(
      (await readdir(course.destination)).filter((name) => name.endsWith(".pdf")),
      originals,
    );
    for (const [index, name] of originals.entries())
      assert.deepEqual(await readFile(join(course.destination, name)), bytes[index]);
  }));
