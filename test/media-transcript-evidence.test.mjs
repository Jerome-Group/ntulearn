import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mediaArtifactEvidenceUpdate } from "../src/media/worker-state.mjs";
import { mediaRecordingRoot } from "../src/media/storage.mjs";
import { runMediaQueue } from "../src/media/worker.mjs";
import { readMediaQueue, writeMediaQueue } from "../src/media/queue.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-owned-alias-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course"),
    alias = join(root, "alias"),
    mediaRoot = join(root, "media");
  await mkdir(destination);
  await symlink(destination, alias);
  const job = {
    recordingId: "content-tree:_1_1:lecture",
    complete: true,
    stage: "complete",
    transcript: { complete: true, sourceKind: "provider" },
    attempts: 4,
    placement: { destination: alias, formattedTranscriptPath: "lecture.md" },
  };
  const sourceRoot = mediaRecordingRoot(mediaRoot, job.recordingId);
  await mkdir(sourceRoot, { recursive: true });
  job.artifacts = {
    rawTranscript: join(sourceRoot, "transcript.raw.json"),
    formattedTranscript: join(alias, "lecture.md"),
  };
  const proof = {
    recordingId: job.recordingId,
    sourceSha256: sha("source"),
    formattedSha256: sha("formatted"),
  };
  await writeFile(job.artifacts.rawTranscript, "source");
  await writeFile(join(destination, "lecture.md"), "formatted");
  await writeFile(join(sourceRoot, "transcript.metadata.json"), JSON.stringify(proof));
  return {
    root,
    destination,
    alias,
    mediaRoot,
    sourceRoot,
    proof,
    job,
    options: { mediaRoot, course: { destination } },
  };
}

test("owned course-root alias repairs only verified formatted artifact evidence", async (t) => {
  const f = await fixture(t);
  const update = await mediaArtifactEvidenceUpdate(f.job, f.options);
  assert.equal(update.artifacts.formattedTranscript, join(f.destination, "lecture.md"));
  assert.equal(update.sourceSha256, f.proof.sourceSha256);
  assert.equal(update.formattedSha256, f.proof.formattedSha256);
  assert.equal(Object.hasOwn(update, "attempts"), false);
  assert.equal(await readFile(join(f.destination, "lecture.md"), "utf8"), "formatted");
  assert.equal(await mediaArtifactEvidenceUpdate({ ...f.job, ...update }, f.options), null);
});

test("recorded and configured root aliases accept their proven canonical reference on repeat", async (t) => {
  const f = await fixture(t);
  const configured = join(f.root, "configured-alias");
  await symlink(f.destination, configured);
  const options = { ...f.options, course: { destination: configured } };
  const before = await readFile(join(f.destination, "lecture.md"));
  const update = await mediaArtifactEvidenceUpdate(f.job, options);
  assert.equal(update.artifacts.formattedTranscript, join(f.destination, "lecture.md"));
  assert.equal(await mediaArtifactEvidenceUpdate({ ...f.job, ...update }, options), null);
  assert.deepEqual(await readFile(join(f.destination, "lecture.md")), before);
});

test("foreign unavailable unsafe and contradictory alias references require review", async (t) => {
  for (const kind of [
    "foreign",
    "unavailable",
    "relative escape",
    "contradictory reference",
    "edited source",
    "edited derivative",
    "missing source",
    "missing derivative",
    "empty derivative",
    "missing proof",
    "conflicting proof",
    "wrong recording proof",
  ]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === "foreign") {
        await rm(f.alias);
        const foreign = join(f.root, "foreign");
        await mkdir(foreign);
        await symlink(foreign, f.alias);
      }
      if (kind === "unavailable") await rm(f.alias);
      if (kind === "relative escape")
        f.job.placement.formattedTranscriptPath = "../course/lecture.md";
      if (kind === "contradictory reference")
        f.job.artifacts.formattedTranscript = join(f.alias, "other.md");
      if (kind === "edited source") await writeFile(f.job.artifacts.rawTranscript, "Owner edit");
      if (kind === "edited derivative")
        await writeFile(join(f.destination, "lecture.md"), "Owner edit");
      if (kind === "missing source") await rm(f.job.artifacts.rawTranscript);
      if (kind === "missing derivative") await rm(join(f.destination, "lecture.md"));
      if (kind === "empty derivative") await writeFile(join(f.destination, "lecture.md"), "");
      if (kind === "missing proof") await rm(join(f.sourceRoot, "transcript.metadata.json"));
      if (kind === "conflicting proof")
        await writeFile(
          join(f.sourceRoot, "transcript.state.json"),
          JSON.stringify({ ...f.proof, formattedSha256: sha("different") }),
        );
      if (kind === "wrong recording proof")
        await writeFile(
          join(f.sourceRoot, "transcript.metadata.json"),
          JSON.stringify({ ...f.proof, recordingId: "foreign" }),
        );
      const result = await mediaArtifactEvidenceUpdate(f.job, f.options);
      assert.equal(result.complete, false);
      assert.equal(result.retryable, false);
      assert.equal(result.stage, "failed");
      assert.equal(Object.hasOwn(result, "artifacts"), false);
      assert.match(result.limitations.join(" "), /review/i);
    });
  }
});

test("a nested derivative symlink refuses despite a same-course root alias", async (t) => {
  const f = await fixture(t);
  await rm(join(f.destination, "lecture.md"));
  const foreign = join(f.root, "foreign.md");
  await writeFile(foreign, "formatted");
  await symlink(foreign, join(f.destination, "lecture.md"));
  await assert.rejects(mediaArtifactEvidenceUpdate(f.job, f.options));
  assert.equal(await readFile(foreign, "utf8"), "formatted");
});

test("canonicalized alias references still require current metadata proof on repeat", async (t) => {
  const f = await fixture(t);
  const update = await mediaArtifactEvidenceUpdate(f.job, f.options);
  await rm(join(f.sourceRoot, "transcript.metadata.json"));
  const result = await mediaArtifactEvidenceUpdate({ ...f.job, ...update }, f.options);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, false);
  assert.equal(await readFile(join(f.destination, "lecture.md"), "utf8"), "formatted");
});

test("root alias retargeting before the post-read binding check cannot retain completeness", async (t) => {
  const f = await fixture(t);
  const foreign = join(f.root, "foreign");
  await mkdir(foreign);
  let resolvedAlias = false;
  const result = await mediaArtifactEvidenceUpdate(f.job, {
    ...f.options,
    resolveRoot: async (path) => {
      const actual = await realpath(path);
      if (path === f.alias && !resolvedAlias) {
        resolvedAlias = true;
        await rm(f.alias);
        await symlink(foreign, f.alias);
      }
      return actual;
    },
  });
  assert.equal(resolvedAlias, true);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, false);
  assert.equal(Object.hasOwn(result, "artifacts"), false);
});

test("owned alias reconciliation respects interruption and global safety admission", async (t) => {
  for (const mode of ["processed", "interrupted", "unsafe"]) {
    await t.test(mode, async (t) => {
      const interrupted = mode !== "processed";
      const f = await fixture(t);
      const course = {
        key: "OWN1000",
        courseId: "_1_1",
        mediaMode: "pilot",
        destination: f.destination,
      };
      const statePath = join(f.root, "state.json");
      const second = globalThis.structuredClone(f.job);
      second.recordingId += "-second";
      second.placement.formattedTranscriptPath = "second.md";
      const secondRoot = mediaRecordingRoot(f.mediaRoot, second.recordingId);
      await mkdir(secondRoot, { recursive: true });
      second.artifacts = {
        rawTranscript: join(secondRoot, "transcript.raw.json"),
        formattedTranscript: join(f.alias, "second.md"),
      };
      await writeFile(second.artifacts.rawTranscript, "source");
      await writeFile(join(f.destination, "second.md"), "formatted");
      await writeFile(
        join(secondRoot, "transcript.metadata.json"),
        JSON.stringify({ ...f.proof, recordingId: second.recordingId }),
      );
      const queue = [f.job, second].map((job) => ({
        ...job,
        courseKey: course.key,
        courseId: course.courseId,
        checkpoint: { at: "2026-01-01T00:00:00Z", reason: "retained history" },
      }));
      await writeMediaQueue({
        statePath,
        course,
        discovery: { complete: true, verdict: "green", queue },
      });
      const controller = new globalThis.AbortController();
      const first = {
        key: "FIRST1000",
        courseId: "_2_1",
        mediaMode: "pilot",
        destination: join(f.root, "first"),
      };
      await mkdir(first.destination);
      if (interrupted)
        await writeMediaQueue({
          statePath,
          course: first,
          discovery: {
            complete: true,
            verdict: "green",
            queue: [
              {
                recordingId: "content-tree:_2_1:first",
                courseKey: first.key,
                courseId: first.courseId,
                stage: "queued",
              },
            ],
          },
        });
      let acquisitions = 0;
      const queueBefore = await readFile(
        (await readMediaQueue({ statePath, courseKey: course.key, course })).path,
      );
      const run = () =>
        runMediaQueue({
          statePath,
          courses: interrupted ? [first, course] : [course],
          mode: "manual",
          media: { mediaRoot: f.mediaRoot },
          preflight: async () => {},
          checkCapacity: async () => {},
          signal: controller.signal,
          runJob: async () => {
            acquisitions++;
            assert.equal(interrupted, true);
            if (mode === "unsafe")
              throw Object.assign(new Error("Cleanup unconfirmed"), {
                code: "MEDIA_PROCESS_CLEANUP",
                globalSafety: true,
              });
            controller.abort(new Error("Owner interruption"));
            return { complete: false, stage: "failed" };
          },
        });
      const result = await run();
      assert.equal(result.counts.completed, 2);
      assert.equal(acquisitions, interrupted ? 1 : 0);
      assert.equal(result.globalStop, mode === "unsafe");
      if (mode === "unsafe") {
        assert.equal(result.verdict, "red");
        assert.equal(
          (
            await readFile(
              (await readMediaQueue({ statePath, courseKey: course.key, course })).path,
            )
          ).equals(queueBefore),
          true,
        );
        return;
      }
      const repaired = (await readMediaQueue({ statePath, courseKey: course.key, course })).record
        .queue;
      for (let i = 0; i < repaired.length; i++) {
        assert.equal(
          repaired[i].artifacts.formattedTranscript,
          join(f.destination, i ? "second.md" : "lecture.md"),
        );
        assert.equal(repaired[i].attempts, 4);
        assert.deepEqual(repaired[i].checkpoint, queue[i].checkpoint);
        assert.deepEqual(repaired[i].placement, queue[i].placement);
      }
      if (!interrupted) {
        assert.equal((await run()).counts.completed, 2);
        assert.equal(acquisitions, 0);
        assert.deepEqual(
          (await readMediaQueue({ statePath, courseKey: course.key, course })).record.queue,
          repaired,
        );
      }
    });
  }
});
