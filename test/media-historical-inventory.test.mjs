import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { historicalInventory } from "../src/media/historical-inventory.mjs";
import { historicalDigest } from "../src/media/historical-files.mjs";
import { mediaRecordingRoot } from "../src/media/storage.mjs";

test("all-course inventory includes native, orphan and disabled derivatives", async (t) => {
  const at = await historicalFixture(t);
  await writeFile(
    join(at.config.courses[1].destination, "orphan.transcript.md"),
    "Retained orphan words",
  );
  await writeFile(join(at.config.media.mediaRoot, "transcript.raw.json"), at.raw);
  const value = await historicalInventory({ config: at.config });
  assert.equal(value.roots.length, 3);
  assert.equal(value.derivatives.length, 2);
  assert.equal(value.sources.length, 3);
  assert.equal(value.editions.length, 1);
  assert.equal(value.editions[0].lexical, "failed");
  assert.equal(value.sources.filter((source) => source.association === "unassociated").length, 2);
});
test("recording metadata selects matching identity from competing queue placements", async (t) => {
  const at = await historicalFixture(t);
  await writeFile(
    at.queuePath,
    JSON.stringify({
      courseKey: "course",
      courseId: "synthetic-course",
      queue: [{ ...at.job, recordingId: "wrong-identity" }, at.job],
    }),
  );
  const value = await historicalInventory({ config: at.config });
  assert.equal(value.editions.length, 1);
  assert.equal(value.editions[0].recordingId, at.job.recordingId);
});
test("two independently proven claims are ambiguous and never chosen first", async (t) => {
  const at = await historicalFixture(t),
    otherId = "other-stable-identity";
  const other = mediaRecordingRoot(at.config.media.mediaRoot, otherId);
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "transcript.raw.json"), at.raw);
  await writeFile(
    join(other, "transcript.metadata.json"),
    JSON.stringify({ ...at.metadata, recordingId: otherId }),
  );
  await writeFile(
    at.queuePath,
    JSON.stringify({
      courseKey: "course",
      courseId: "synthetic-course",
      queue: [at.job, { ...at.job, recordingId: otherId }],
    }),
  );
  const value = await historicalInventory({ config: at.config });
  assert.equal(value.editions.length, 0);
  assert.equal(value.sources.filter((source) => source.association === "ambiguous").length, 2);
});
test("aliases require positive physical course identity; changed user derivative stays unassociated", async (t) => {
  const at = await historicalFixture(t),
    alias = join(at.root, "alias");
  await symlink(at.config.courses[0].destination, alias);
  await writeFile(
    at.queuePath,
    JSON.stringify({
      courseKey: "course",
      courseId: "synthetic-course",
      queue: [{ ...at.job, placement: { ...at.job.placement, destination: alias } }],
    }),
  );
  assert.equal((await historicalInventory({ config: at.config })).editions.length, 1);
  await writeFile(at.originalPath, "Student edit");
  assert.equal((await historicalInventory({ config: at.config })).editions.length, 0);
  assert.notEqual(historicalDigest("Student edit"), at.metadata.formattedSha256);
});

test("state-only orphan associations require recording course identity as well as physical placement and hashes", async (t) => {
  const at = await historicalFixture(t);
  await writeFile(
    at.queuePath,
    JSON.stringify({ courseKey: "course", courseId: "synthetic-course", queue: [] }),
  );
  const wrongPath = join(at.config.courses[1].destination, "Lecture.transcript.md");
  await writeFile(wrongPath, at.original);
  const statePath = join(at.recordRoot, "transcript.state.json");
  const state = {
    recordingId: at.job.recordingId,
    sourceSha256: at.metadata.sourceSha256,
    formattedSha256: at.metadata.formattedSha256,
    artifacts: { formattedTranscript: wrongPath },
  };
  await writeFile(statePath, JSON.stringify(state));
  const wrong = await historicalInventory({ config: at.config });
  assert.equal(wrong.editions.length, 0);
  assert.ok(wrong.derivatives.every((derivative) => derivative.association !== "proven"));
  await writeFile(
    statePath,
    JSON.stringify({ ...state, artifacts: { formattedTranscript: at.originalPath } }),
  );
  const correct = await historicalInventory({ config: at.config });
  assert.equal(correct.editions.length, 1);
  assert.equal(correct.editions[0].courseKey, "course");
});

test("a coherent queue cannot transfer a recognizable recording identity to another course", async (t) => {
  const at = await historicalFixture(t);
  await writeFile(
    at.queuePath,
    JSON.stringify({ courseKey: "course", courseId: "synthetic-course", queue: [] }),
  );
  const destination = at.config.courses[1].destination;
  await writeFile(join(destination, "Lecture.transcript.md"), at.original);
  const { mediaQueuePath } = await import("../src/media/queue.mjs");
  await writeFile(
    mediaQueuePath(at.config.statePath, "disabled"),
    JSON.stringify({
      courseKey: "disabled",
      courseId: "disabled-course",
      queue: [
        {
          ...at.job,
          courseKey: "disabled",
          courseId: "disabled-course",
          placement: { ...at.job.placement, destination },
        },
      ],
    }),
  );
  assert.equal((await historicalInventory({ config: at.config })).editions.length, 0);
});
