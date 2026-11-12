import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expectedFiles } from "../src/sync/expected.mjs";
import { syncCourse } from "../src/sync/course.mjs";
import { verifyCourse } from "../src/sync/verify.mjs";

const ROOT =
  "https://ntulearn.ntu.edu.sg/bbcswebdav/internal/courses/SYNTHETIC-101/announcements/_7_1/";
const snapshot = (links) => ({
  course: { id: "_9_1", displayId: "SYNTHETIC-101", displayName: "Synthetic course" },
  items: [],
  conversations: [],
  announcements: [
    {
      id: "_7_1",
      title: "Review",
      createdDate: "2026-01-01",
      body: { displayText: links.map((url) => `<a href="${url}">PDF</a>`).join("\n") },
    },
  ],
});

test("announcement PDFs are missing before sync and present after additive download", async () => {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-announcement-"));
  const urls = [`${ROOT}Review.pdf`, `${ROOT}Formulas.pdf`];
  const downloaded = [];
  const client = {
    readCourse: async () => {
      const current = snapshot([urls[0], urls[0]]);
      current.announcements[0].body.rawText = `<a href="${urls[1]}"></a>`;
      return current;
    },
    download: async (attachment) => {
      downloaded.push(attachment.resourceUrl);
      return {
        body: Buffer.from("%PDF-synthetic"),
        headers: { "content-type": "application/pdf" },
      };
    },
  };
  const course = { key: "SYNTHETIC", courseId: "_9_1", destination };
  const state = { version: 1, courses: {} };
  try {
    const before = await verifyCourse({ client, course });
    assert.equal(before.attachments, 2);
    assert.equal(before.missing.filter((entry) => entry.file.endsWith(".pdf")).length, 2);
    const result = await syncCourse({ client, course, state });
    assert.equal(result.downloaded, 2);
    assert.deepEqual(downloaded.sort(), [...urls].sort());
    for (const name of ["Review.pdf", "Formulas.pdf"])
      assert.equal(
        await readFile(join(destination, "Announcements", "_7_1", name), "utf8"),
        "%PDF-synthetic",
      );
    const after = await verifyCourse({ client, course });
    assert.deepEqual(after.missing, []);
    assert.equal(after.attachments, 2);
    const repeated = await syncCourse({ client, course, state });
    assert.equal(repeated.downloaded, 0);
    assert.equal(repeated.skipped, 2);
    assert.equal(downloaded.length, 2);
    for (const name of ["Review.pdf", "Formulas.pdf"])
      assert.equal(
        await readFile(join(destination, "Announcements", "_7_1", name), "utf8"),
        "%PDF-synthetic",
      );
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("announcement extraction excludes links outside its exact PDF ownership boundary", async () => {
  const urls = [
    `${ROOT}Review.pdf`,
    `${ROOT}Readme.txt`,
    ROOT.replace("ntulearn.ntu.edu.sg", "example.com") + "Review.pdf",
    ROOT.replace("SYNTHETIC-101", "OTHER") + "Review.pdf",
    ROOT.replace("_7_1", "_8_1") + "Review.pdf",
    `${ROOT}Review.pdf?token=synthetic`,
    `${ROOT}Review.pdf#fragment`,
    `${ROOT}nested/Review.pdf`,
    `${ROOT}bad%2FReview.pdf`,
    `${ROOT}bad%5CReview.pdf`,
    `${ROOT}bad%00.pdf`,
    ROOT.replace("https://", "https://user:password@") + "Review.pdf",
  ];
  const expected = [];
  for await (const entry of expectedFiles({
    client: {},
    courseId: "_9_1",
    snapshot: snapshot(urls),
  }))
    expected.push(entry);
  const attachments = expected.filter((entry) => entry.kind === "attachment");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].attachment.resourceUrl, urls[0]);
});
