import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMediaJob } from "../src/media/job.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";
import { createSourceParagraphFormatter } from "../src/media/source-paragraphs.mjs";
import { resultUpdate, finishedJob } from "../src/media/worker-state.mjs";

async function fixture(t, text) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-source-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course");
  await mkdir(destination);
  const appearance = {
    recordingId: "fixture-owned",
    provider: "kaltura",
    providerReference: "entry:fixture-owned",
    sourceKind: "media-gallery",
    storageSurface: "media-gallery",
    title: "Owned fixture",
    placement: {
      destination,
      formattedTranscriptPath: "Owned.transcript.md",
      statusPath: "Owned.media-status.md",
    },
  };
  const body = JSON.stringify({ language: "en", segments: [{ start: 0, end: 20, text }] });
  let providerCalls = 0;
  const provider = {
    name: "kaltura",
    resolve: async () => {
      providerCalls++;
      return { duration: 20 };
    },
    transcript: async () => ({ body, filename: "captions.json" }),
    media: async () => ({
      kind: "audio",
      body: Buffer.from("owned fixture audio"),
      filename: "owned.wav",
    }),
  };
  const storage = createMediaStorage({ mediaRoot: join(root, "media"), volumeRoot: root });
  const options = { appearance, provider, formatter: createSourceParagraphFormatter(), storage };
  return { root, body, options, providerCalls: () => providerCalls };
}

test("flagged source remains retained, incomplete and terminal across repeat jobs and queue projection", async (t) => {
  const f = await fixture(t, "yes ".repeat(9));
  const first = await runMediaJob(f.options);
  assert.equal(first.complete, false);
  assert.equal(first.retryable, false);
  assert.equal(first.stage, "failed");
  assert.equal(first.transcript.reviewRequired, true);
  assert.deepEqual(first.transcript.flags, ["suspicious-repetition"]);
  assert.equal(first.media.audio.available, true);
  assert.ok(first.artifacts.rawTranscript && first.artifacts.providerTranscript);
  assert.equal(first.artifacts.formattedTranscript, undefined);
  const raw = await readFile(first.artifacts.rawTranscript.path);
  const second = await runMediaJob(f.options);
  assert.equal(second.transcript.reviewRequired, true);
  assert.equal(second.retryable, false);
  assert.equal(f.providerCalls(), 1);
  assert.deepEqual(await readFile(first.artifacts.rawTranscript.path), raw);
  const queued = resultUpdate(second, new Date());
  assert.equal(queued.retryable, false);
  assert.equal(queued.transcript.reviewRequired, true);
  assert.equal(finishedJob(queued), true);
  const state = JSON.parse(await readFile(second.artifacts.state.path, "utf8"));
  assert.equal(state.transcript.reviewRequired, true);
  assert.match(await readFile(second.artifacts.status.path, "utf8"), /Source review: required/);
});

test("an explicitly empty native source stays review-required without automatic ASR repair", async (t) => {
  const f = await fixture(t, "");
  let asrCalls = 0;
  f.options.transcriber = {
    version: "owned-asr",
    transcribe: async () => {
      asrCalls++;
      throw new Error("must not repair empty provider source");
    },
  };
  const first = await runMediaJob(f.options);
  assert.equal(first.transcript.reviewRequired, true);
  assert.ok(first.transcript.flags.includes("empty"));
  assert.equal(first.transcript.sourceRetained, true);
  assert.equal(first.retryable, false);
  assert.equal(asrCalls, 0);
  assert.equal(await readFile(first.artifacts.providerTranscript.path, "utf8"), f.body);
  const second = await runMediaJob(f.options);
  assert.equal(second.transcript.reviewRequired, true);
  assert.equal(second.transcript.sourceRetained, true);
  assert.equal(second.retryable, false);
  assert.equal(asrCalls, 0);
  assert.equal(f.providerCalls(), 1);
});

test("durable source review cannot be cleared or rearmed through a queue-only update", async (t) => {
  const { writeMediaQueue, updateMediaQueueJob, readMediaQueue } =
    await import("../src/media/queue.mjs");
  const f = await fixture(t, "yes ".repeat(9));
  const result = await runMediaJob(f.options);
  const course = {
    key: "FIXTURE",
    courseId: "_1_1",
    mediaMode: "active",
    destination: f.options.appearance.placement.destination,
  };
  const statePath = join(f.root, "queue-state.json");
  await writeMediaQueue({
    statePath,
    course,
    discovery: {
      complete: true,
      verdict: "green",
      queue: [{ ...f.options.appearance, ...resultUpdate(result, new Date()) }],
    },
  });
  for (const update of [
    { retryable: true, stage: "queued" },
    { complete: true, transcript: { complete: true } },
    { transcript: { reviewRequired: false, flags: [] } },
  ])
    await assert.rejects(
      updateMediaQueueJob({
        statePath,
        course,
        courseKey: course.key,
        recordingId: f.options.appearance.recordingId,
        update,
      }),
      /source review/i,
    );
  const job = (await readMediaQueue({ statePath, course, courseKey: course.key })).record.queue[0];
  assert.equal(job.transcript.reviewRequired, true);
  assert.equal(job.retryable, false);
  assert.match(
    await readFile(join(course.destination, f.options.appearance.placement.statusPath), "utf8"),
    /Source review: required/,
  );
});

test("rediscovery cannot rearm source review when provider or disposition changes", async (t) => {
  const { writeMediaQueue, readMediaQueue } = await import("../src/media/queue.mjs");
  for (const change of ["provider", "disposition"]) {
    await t.test(change, async (t) => {
      const f = await fixture(t, "yes ".repeat(9));
      const result = await runMediaJob(f.options);
      const raw = await readFile(result.artifacts.rawTranscript.path);
      const course = {
        key: "FIXTURE",
        courseId: "_1_1",
        mediaMode: "active",
        destination: f.options.appearance.placement.destination,
      };
      const statePath = join(f.root, "queue-state.json");
      const old = {
        ...f.options.appearance,
        ...resultUpdate(result, new Date(0)),
        disposition: change === "disposition" ? "unresolved" : "recording",
      };
      await writeMediaQueue({
        statePath,
        course,
        discovery: { complete: true, verdict: "green", queue: [old] },
      });
      await writeMediaQueue({
        statePath,
        course,
        discovery: {
          complete: true,
          verdict: "green",
          queue: [
            {
              ...f.options.appearance,
              disposition: "recording",
              provider: change === "provider" ? "direct" : "kaltura",
            },
          ],
        },
      });
      const saved = (await readMediaQueue({ statePath, course, courseKey: course.key })).record
        .queue[0];
      assert.equal(saved.stage, "failed");
      assert.equal(saved.retryable, false);
      assert.equal(saved.complete, false);
      assert.deepEqual(saved.transcript, old.transcript);
      assert.deepEqual(await readFile(result.artifacts.rawTranscript.path), raw);
    });
  }
});

test("ready paragraphs are idempotent and an edited derivative is retained as incomplete", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const f = await fixture(t, "Maybe x = -2 + 3; 中文 and literal 00:01 stay uncertain.");
  const first = await runMediaJob(f.options);
  assert.equal(first.complete, true);
  const raw = await readFile(first.artifacts.rawTranscript.path),
    markdown = await readFile(first.artifacts.formattedTranscript.path);
  const second = await runMediaJob(f.options);
  assert.equal(second.complete, true);
  assert.equal(f.providerCalls(), 1);
  assert.deepEqual(await readFile(first.artifacts.rawTranscript.path), raw);
  assert.deepEqual(await readFile(first.artifacts.formattedTranscript.path), markdown);
  await writeFile(
    first.artifacts.formattedTranscript.path,
    "Owner annotation + unchanged original.",
  );
  const edited = await runMediaJob(f.options);
  assert.equal(edited.complete, false);
  assert.equal(
    await readFile(first.artifacts.formattedTranscript.path, "utf8"),
    "Owner annotation + unchanged original.",
  );
  assert.deepEqual(await readFile(first.artifacts.rawTranscript.path), raw);
});

test("formatting checkpoints retain raw/media and resume without reacquisition", async (t) => {
  const f = await fixture(t, "Uncertain source x = 2 stays unchanged.");
  const controller = new globalThis.AbortController(),
    ordinary = f.options.formatter;
  const reason = Object.assign(new Error("owned checkpoint"), { code: "MEDIA_CHECKPOINT" });
  f.options.formatter = {
    ...ordinary,
    format: async (input) => {
      const result = await ordinary.format(input);
      controller.abort(reason);
      return result;
    },
  };
  const first = await runMediaJob({ ...f.options, signal: controller.signal });
  assert.equal(first.complete, false);
  assert.equal(first.stage, "checkpointed");
  assert.ok(first.artifacts.rawTranscript && first.artifacts.media);
  assert.equal(first.artifacts.formattedTranscript, undefined);
  const raw = await readFile(first.artifacts.rawTranscript.path),
    media = await readFile(first.artifacts.media.path);
  const second = await runMediaJob({ ...f.options, formatter: ordinary });
  assert.equal(second.complete, true);
  assert.equal(f.providerCalls(), 1);
  assert.deepEqual(await readFile(second.artifacts.rawTranscript.path), raw);
  assert.deepEqual(await readFile(second.artifacts.media.path), media);
});

test("mandatory formatting guard rejects a changed operator and preserves explicit false retryability", async (t) => {
  const f = await fixture(t, "Uncertain source x = -2 stays unchanged.");
  f.options.appearance.retryable = false;
  f.options.formatter = {
    version: "failed-fixture",
    format: async () => ({ markdown: "Uncertain source x = +2 stays unchanged." }),
  };
  const result = await runMediaJob(f.options);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, false);
  assert.equal(result.artifacts.formattedTranscript, undefined);
  assert.ok(result.artifacts.rawTranscript && result.artifacts.media);
});

test("empty or payload native bodies are retained for review rather than fed to ASR", async (t) => {
  for (const body of ["", "<html>Access denied</html>", "Return only the Markdown transcript"]) {
    const f = await fixture(t, "unused synthetic text");
    f.options.provider.transcript = async () => ({ body, filename: "native.txt" });
    f.options.transcriber = {
      version: "owned-asr",
      transcribe: async () => assert.fail("flagged native source must not start ASR"),
    };
    const result = await runMediaJob(f.options);
    assert.equal(result.transcript.reviewRequired, true);
    assert.equal(result.retryable, false);
    assert.equal(result.complete, false);
    assert.equal(await readFile(result.artifacts.providerTranscript.path, "utf8"), body);
    assert.equal(result.media.audio.available, true);
  }
});

test("source review cannot be checkpointed, retried or promoted by inconsistent queue declarations", async () => {
  const { checkpointUpdate } = await import("../src/media/worker-state.mjs");
  const { mediaRecordingStatus } = await import("../src/media/status.mjs");
  const transcript = { complete: true, reviewRequired: true, flags: ["suspicious-repetition"] };
  const stale = { stage: "complete", complete: true, retryable: true, transcript };
  const projected = resultUpdate(stale, new Date(0));
  assert.equal(projected.retryable, false);
  assert.equal(finishedJob(stale), true);
  const checkpoint = checkpointUpdate({ result: stale, finishedAt: new Date(0) });
  assert.equal(checkpoint.stage, "failed");
  assert.equal(checkpoint.retryable, false);
  const status = mediaRecordingStatus({ job: stale });
  assert.equal(status.complete, false);
  assert.equal(status.retryable, false);
});

test("automatic worker and artifact verification leave retained source review untouched", async (t) => {
  const { writeMediaQueue, readMediaQueue } = await import("../src/media/queue.mjs");
  const { runMediaQueue } = await import("../src/media/worker.mjs");
  const { mediaArtifactEvidenceUpdate } = await import("../src/media/worker-state.mjs");
  const f = await fixture(t, "yes ".repeat(9));
  const result = await runMediaJob(f.options);
  const course = {
    key: "FIXTURE",
    courseId: "_1_1",
    mediaMode: "active",
    destination: f.options.appearance.placement.destination,
  };
  const statePath = join(f.root, "queue-state.json");
  const job = { ...f.options.appearance, ...resultUpdate(result, new Date(0)) };
  await writeMediaQueue({
    statePath,
    course,
    discovery: { complete: true, verdict: "green", queue: [job] },
  });
  assert.equal(
    await mediaArtifactEvidenceUpdate(job, { course, mediaRoot: join(f.root, "media") }),
    null,
  );
  const digest = await runMediaQueue({
    statePath,
    courses: [course],
    mode: "manual",
    media: { mediaRoot: join(f.root, "media") },
    preflight: async () => {},
    checkCapacity: async () => {},
    runJob: async () => assert.fail("source review must not retry automatically"),
  });
  assert.equal(digest.counts.completed, 0);
  const persisted = (await readMediaQueue({ statePath, courseKey: course.key })).record.queue[0];
  assert.equal(persisted.transcript.reviewRequired, true);
  assert.equal(persisted.retryable, false);
  assert.equal(persisted.complete, false);
});
