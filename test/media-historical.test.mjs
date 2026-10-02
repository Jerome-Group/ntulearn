import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { mediaRecordingRoot } from "../src/media/storage.mjs";
import { historicalTranscripts } from "../src/media/historical.mjs";

test("plan apply verify reuses hash evidence and leaves all historical originals and queues intact", async (t) => {
  const at = await historicalFixture(t),
    queueBefore = await readFile(at.queuePath, "utf8");
  const options = { config: at.config, manifestPath: at.manifestPath };
  const plan = await historicalTranscripts({ ...options, mode: "plan" });
  assert.equal(plan.status, "passed");
  assert.equal(plan.evidence.lexicalFailures, 1);
  const applied = await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies);
  assert.equal(applied.status, "passed");
  assert.equal(applied.evidence.eligible, 1);
  const verified = await historicalTranscripts({ ...options, mode: "verify" });
  assert.equal(verified.status, "passed");
  const repeat = await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies);
  assert.equal(repeat.status, "passed");
  assert.equal(repeat.evidence.written, 0);
  assert.equal(await readFile(at.sourcePath, "utf8"), at.raw);
  assert.equal(await readFile(at.originalPath, "utf8"), at.original);
  assert.equal(await readFile(at.queuePath, "utf8"), queueBefore);
  assert.equal(
    await readFile(join(at.config.courses[0].destination, "student.md"), "utf8"),
    "Student untouched bytes",
  );
  const [editionFolder] = await readdir(
    join(at.config.courses[0].destination, "Transcript editions"),
  );
  const index = await readFile(
    join(at.config.courses[0].destination, "Transcript editions", editionFolder, "index.md"),
    "utf8",
  );
  assert.match(index, /Open paragraph edition/);
  assert.match(index, /raw transcript/);
  assert.match(index, /Timing: passed/);
  assert.equal(verified.evidence.mediaReadiness, "unclaimed");
});
test("interruption preserves exclusive partial edition and resumes identical plan", async (t) => {
  const at = await historicalFixture(t),
    options = { config: at.config, manifestPath: at.manifestPath };
  await historicalTranscripts({ ...options, mode: "plan" });
  const first = await historicalTranscripts(
    { ...options, mode: "apply" },
    {
      ...at.dependencies,
      afterOutput: async () => {
        throw new Error("Synthetic interruption");
      },
    },
  );
  assert.equal(first.status, "failed");
  const resumed = await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies);
  assert.equal(resumed.status, "passed");
  assert.ok(resumed.evidence.existing >= 1);
  assert.equal((await historicalTranscripts({ ...options, mode: "verify" })).status, "passed");
});
test("changed input or occupied edited edition refuses without replacing any bytes", async (t) => {
  const at = await historicalFixture(t),
    options = { config: at.config, manifestPath: at.manifestPath };
  await historicalTranscripts({ ...options, mode: "plan" });
  await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies);
  const folder = join(
    at.config.courses[0].destination,
    "Transcript editions",
    (await readdir(join(at.config.courses[0].destination, "Transcript editions")))[0],
  );
  const edition = (await readdir(folder)).find(
    (name) => name.startsWith("recording-") && name.endsWith(".md"),
  );
  await writeFile(join(folder, edition), "Student-edited repaired edition");
  assert.equal(
    (await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(join(folder, edition), "utf8"), "Student-edited repaired edition");
  await writeFile(at.sourcePath, at.raw.replace("First", "Different"));
  assert.equal((await historicalTranscripts({ ...options, mode: "verify" })).status, "failed");
  assert.equal(await readFile(at.originalPath, "utf8"), at.original);
});
test("unsafe manifest additions and missing native sources do not create guessed editions", async (t) => {
  const at = await historicalFixture(t),
    options = { config: at.config, manifestPath: at.manifestPath };
  await historicalTranscripts({ ...options, mode: "plan" });
  const value = JSON.parse(await readFile(at.manifestPath, "utf8"));
  value.editions[0].coursePath = at.root;
  await writeFile(at.manifestPath, JSON.stringify(value));
  assert.equal(
    (await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies)).status,
    "failed",
  );
});

test("verify requires immutable checkpoint evidence and timing failures never become ready media", async (t) => {
  const at = await historicalFixture(t),
    options = { config: at.config, manifestPath: at.manifestPath };
  await writeFile(at.metadataPath, JSON.stringify({ ...at.metadata, duration: 1000 }));
  const plan = await historicalTranscripts({ ...options, mode: "plan" });
  assert.equal(plan.evidence.timingFailures, 1);
  assert.equal(plan.evidence.eligible, 1);
  const applied = await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies);
  assert.equal(applied.evidence.mediaReadiness, "unclaimed");
  const folder = join(
    at.config.courses[0].destination,
    "Transcript editions",
    (await readdir(join(at.config.courses[0].destination, "Transcript editions")))[0],
  );
  const receipt = (await readdir(folder)).find((name) => name.endsWith(".receipt.json"));
  await writeFile(join(folder, receipt), "Altered receipt");
  assert.equal((await historicalTranscripts({ ...options, mode: "verify" })).status, "failed");
});

test("held media lock and source mutation during apply stop without touching originals", async (t) => {
  const at = await historicalFixture(t),
    options = { config: at.config, manifestPath: at.manifestPath };
  await historicalTranscripts({ ...options, mode: "plan" });
  const { withMediaQueueLock } = await import("../src/media/lock.mjs");
  await withMediaQueueLock({
    statePath: at.config.statePath,
    run: async () =>
      assert.equal(
        (await historicalTranscripts({ ...options, mode: "apply" }, at.dependencies)).status,
        "failed",
      ),
  });
  const failed = await historicalTranscripts(
    { ...options, mode: "apply" },
    {
      ...at.dependencies,
      afterOutput: async () => {
        await writeFile(at.sourcePath, at.raw.replace("First", "Changed"));
      },
    },
  );
  assert.equal(failed.status, "failed");
  assert.equal(await readFile(at.originalPath, "utf8"), at.original);
});

test("session-address identity or provenance fails before private manifest retention", async (t) => {
  for (const field of ["recordingId", "recordingReference"]) {
    const at = await historicalFixture(t);
    const sensitive = "https://example.invalid/path/ks/SYNTHETIC_TOKEN/entry/stable";
    at.metadata[field] = sensitive;
    await writeFile(at.metadataPath, JSON.stringify(at.metadata));
    if (field === "recordingId") {
      await rename(at.recordRoot, mediaRecordingRoot(at.config.media.mediaRoot, sensitive));
      at.job.recordingId = sensitive;
      await writeFile(
        at.queuePath,
        JSON.stringify({ courseKey: "course", courseId: "synthetic-course", queue: [at.job] }),
      );
    }
    const value = await historicalTranscripts({
      config: at.config,
      manifestPath: at.manifestPath,
      mode: "plan",
    });
    assert.equal(value.status, "failed");
    assert.equal(JSON.stringify(value).includes("SYNTHETIC_TOKEN"), false);
    await assert.rejects(readFile(at.manifestPath));
  }
});
