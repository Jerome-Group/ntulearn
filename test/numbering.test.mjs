import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { numberingOf } from "../src/sync/numbering.mjs";

async function destinationHolding(...files) {
  const destination = await mkdtemp(join(tmpdir(), "ntulearn-numbering-"));
  for (const file of files) {
    const path = join(destination, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "written");
  }
  return destination;
}

function segmentsOf(path) {
  return path.split("/");
}

function numbering(destination, ...expected) {
  return numberingOf(destination, expected.map(segmentsOf));
}

// MH2100: one item inserted at the top of the course moved every later name by one, and nothing on
// disk moved with it (ADR-0003). Ninety-one of its ninety-two "missing" files were this (#67).
test("finds the file the same name at another number holds", async () => {
  const destination = await destinationHolding("01 Cengage WebAssign.md");
  const found = await numbering(destination, "02 Cengage WebAssign.md").find(
    segmentsOf("02 Cengage WebAssign.md"),
  );

  assert.equal(found, "01 Cengage WebAssign.md");
});

// A folder's own name carries its position too, so a renumbered folder moves everything beneath it.
test("finds a file under a folder whose number moved", async () => {
  const destination = await destinationHolding("02 Lecture Slides/04 Week 1.pdf");
  const expected = "03 Lecture Slides/05 Week 1.pdf";
  const found = await numbering(destination, expected).find(segmentsOf(expected));

  assert.equal(found, "02 Lecture Slides/04 Week 1.pdf");
});

test("prefers the file at the number the sync would write", async () => {
  const destination = await destinationHolding("01 Week 1.pdf", "02 Week 1.pdf");
  const found = await numbering(destination, "02 Week 1.pdf").find(segmentsOf("02 Week 1.pdf"));

  assert.equal(found, "02 Week 1.pdf");
});

test("finds nothing for a file that is on neither number", async () => {
  const destination = await destinationHolding("01 Week 1.pdf");
  const found = await numbering(destination, "03 Week 2.pdf").find(segmentsOf("03 Week 2.pdf"));

  assert.equal(found, null);
});

test("finds nothing in a destination that does not exist", async () => {
  const found = await numbering(join(tmpdir(), "ntulearn-absent"), "01 Week 1.pdf").find(
    segmentsOf("01 Week 1.pdf"),
  );

  assert.equal(found, null);
});

// The mask this check has to avoid: a file another expectation is already counting on cannot also
// stand in for this one, or one course holding a file twice would read as holding it three times.
test("never stands in a file that is expected under its own name", async () => {
  const destination = await destinationHolding("01 Notes.md");
  const numbers = numbering(destination, "01 Notes.md", "04 Notes.md");

  assert.equal(await numbers.find(segmentsOf("01 Notes.md")), "01 Notes.md");
  assert.equal(await numbers.find(segmentsOf("04 Notes.md")), null);
});

// Two items in one folder may share a title, and then the name inside the number identifies
// nothing. A guess there would call a genuinely absent file present, which is the failure this
// whole change is about, pointed the other way.
test("refuses to guess when two expected files share a name", async () => {
  const destination = await destinationHolding("02 Notes.md");
  const numbers = numbering(destination, "03 Notes.md", "07 Notes.md");

  assert.equal(await numbers.find(segmentsOf("03 Notes.md")), null);
  assert.equal(await numbers.find(segmentsOf("07 Notes.md")), null);
});

// A course reordered twice leaves more than one older number, and two scheduled runs are diffed
// against each other, so the answer may not be whichever the filesystem happened to list first.
test("names the same older number on every run", async () => {
  const destination = await destinationHolding("05 Notes.md", "02 Notes.md");
  const found = await numbering(destination, "07 Notes.md").find(segmentsOf("07 Notes.md"));

  assert.equal(found, "02 Notes.md");
});

test("does not take a directory for the file it expects", async () => {
  const destination = await destinationHolding("02 Week 1.pdf/kept.txt");
  const found = await numbering(destination, "03 Week 1.pdf").find(segmentsOf("03 Week 1.pdf"));

  assert.equal(found, null);
});

// An announcement is dated rather than numbered, so nothing about it is a number that moved.
test("says nothing about a name that carries no number", async () => {
  const destination = await destinationHolding("Announcements/2026-08-01 Welcome.md");
  const expected = "Announcements/2026-08-13 Welcome.md";
  const found = await numbering(destination, expected).find(segmentsOf(expected));

  assert.equal(found, null);
});
