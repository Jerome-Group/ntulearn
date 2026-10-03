import assert from "node:assert/strict";
import test from "node:test";
import {
  writeFile,
  readFile,
  rename,
  symlink,
  link,
  mkdir,
  lstat,
  utimes,
  truncate,
  open,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { historicalTranscripts } from "../src/media/historical.mjs";
import { transcriptCatalogue } from "../src/media/catalogue.mjs";
import {
  createCatalogueMediaReads,
  CATALOGUE_MEDIA_LIMITS,
} from "../src/media/catalogue-media-read.mjs";
import { catalogueMediaPath } from "../src/media/catalogue-media.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { withMediaQueueLock } from "../src/media/lock.mjs";
async function fixture(t, { formatted = true } = {}) {
  const f = await historicalFixture(t),
    mediaPath = join(f.config.courses[0].destination, "Lecture.mp4");
  await writeFile(mediaPath, "owned synthetic recording bytes");
  const media = { video: { available: true, path: mediaPath, audio: true } };
  const job = {
    ...f.job,
    storageSurface: "content-tree",
    placement: { ...f.job.placement, videoPath: "Lecture.mp4" },
    media,
  };
  await writeFile(
    f.queuePath,
    JSON.stringify({ courseKey: job.courseKey, courseId: job.courseId, queue: [job] }),
  );
  const metadata = { ...f.metadata, media };
  await writeFile(f.metadataPath, JSON.stringify(metadata));
  const state = {
    recordingId: job.recordingId,
    sourceSha256: metadata.sourceSha256,
    formattedSha256: metadata.formattedSha256,
    media,
    stage: "failed",
    complete: false,
  };
  const statePath = join(f.recordRoot, "transcript.state.json");
  await writeFile(statePath, JSON.stringify(state));
  if (formatted) {
    await historicalTranscripts({ config: f.config, mode: "plan", manifestPath: f.manifestPath });
    await historicalTranscripts(
      { config: f.config, mode: "apply", manifestPath: f.manifestPath },
      f.dependencies,
    );
  }
  return {
    ...f,
    job,
    metadata,
    state,
    statePath,
    mediaPath,
    manifestPath: join(f.root, "catalogue.json"),
  };
}
test("positive historical media access is independent from reading and canonical incomplete verdict", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.queuePath),
    result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  const r = result.catalogue.courses[0].recordings[0];
  assert.equal(r.reading, "verified");
  assert.equal(r.media.complete, false);
  assert.equal(r.mediaPath, f.mediaPath);
  assert.equal(r.mediaAccess.status, "verified");
  assert.equal(r.mediaAccess.acousticVerification, "unrun");
  assert.deepEqual(await readFile(f.queuePath), before);
});
test("owned recording can be linked without an existing paragraph edition", async (t) => {
  const f = await fixture(t, { formatted: false }),
    result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const r = result.catalogue.courses[0].recordings[0];
  assert.equal(r.reading, "incomplete");
  assert.equal(r.mediaPath, f.mediaPath);
  assert.equal(r.mediaAccess.status, "verified");
});
test("positively owned video-only file is accessible without granting ASR or canonical completeness", async (t) => {
  const f = await fixture(t, { formatted: false });
  const queue = JSON.parse(await readFile(f.queuePath));
  queue.queue[0].media.video.audio = false;
  await writeFile(f.queuePath, JSON.stringify(queue));
  for (const path of [f.metadataPath, f.statePath]) {
    const producer = JSON.parse(await readFile(path));
    producer.media.video.audio = false;
    await writeFile(path, JSON.stringify(producer));
  }
  const inspected = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const recording = inspected.catalogue.courses[0].recordings[0];
  assert.equal(recording.mediaAccess.status, "verified");
  assert.equal(recording.mediaPath, f.mediaPath);
  assert.equal(recording.media.complete, false);
  assert.equal(recording.mediaAccess.completeness, "unclaimed");
  assert.equal(recording.mediaAccess.acousticVerification, "unrun");
  assert.equal(recording.preferred, null);
  const options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  assert.match(
    await readFile(join(f.config.courses[0].destination, "Transcript editions/index.md"), "utf8"),
    /Retained media.*Lecture\.mp4/,
  );
  assert.equal((await transcriptCatalogue({ ...options, mode: "verify" })).status, "passed");
});

test("source review stays review while retained media access remains independently verified", async (t) => {
  const f = await fixture(t),
    q = JSON.parse(await readFile(f.queuePath));
  q.queue[0].transcript = {
    reviewRequired: true,
    flags: ["suspicious-repetition"],
    complete: false,
  };
  await writeFile(f.queuePath, JSON.stringify(q));
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" }),
    r = result.catalogue.courses[0].recordings[0];
  assert.equal(r.reading, "review");
  assert.equal(r.preferred, null);
  assert.deepEqual(r.sourceReview.flags, ["suspicious-repetition"]);
  assert.equal(r.mediaAccess.status, "verified");
  assert.equal(r.media.complete, false);
});
test("missing raw or metadata is not required for positively checkpoint-owned media access", async (t) => {
  const f = await fixture(t, { formatted: false });
  const { unlink } = await import("node:fs/promises");
  await unlink(f.sourcePath);
  await unlink(f.metadataPath);
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  const r = result.catalogue.courses[0].recordings[0];
  assert.equal(r.mediaAccess.status, "verified");
  assert.equal(r.reading, "incomplete");
  assert.equal(r.preferred, null);
});
for (const mutation of ["foreign", "metadata", "state", "withdrawn", "duplicate"])
  test(`${mutation} producer ownership remains unproven without streaming foreign media`, async (t) => {
    const f = await fixture(t),
      queue = JSON.parse(await readFile(f.queuePath));
    let hashes = 0;
    if (mutation === "foreign") {
      const foreign = join(f.config.courses[1].destination, "Lecture.mp4");
      await writeFile(foreign, "same title foreign bytes");
      queue.queue[0].media.video.path = foreign;
      queue.queue[0].placement.videoPath = "../disabled/Lecture.mp4";
      f.state.media.video.path = foreign;
      f.metadata.media.video.path = foreign;
      await writeFile(f.statePath, JSON.stringify(f.state));
      await writeFile(f.metadataPath, JSON.stringify(f.metadata));
    }
    if (mutation === "metadata") {
      f.metadata.recordingId = "content-tree:foreign:identity";
      await writeFile(f.metadataPath, JSON.stringify(f.metadata));
    }
    if (mutation === "state") {
      f.state.recordingId = "content-tree:foreign:identity";
      await writeFile(f.statePath, JSON.stringify(f.state));
    }
    if (mutation === "withdrawn") queue.queue[0].withdrawn = true;
    if (mutation === "duplicate") queue.queue.push({ ...queue.queue[0] });
    await writeFile(f.queuePath, JSON.stringify(queue));
    const media = createCatalogueMediaReads();
    const spy = {
      ...media,
      read: async (...args) => {
        hashes++;
        return media.read(...args);
      },
    };
    const result = await transcriptCatalogue(
      { config: f.config, mode: "inspect" },
      { mediaReads: spy },
    );
    assert.equal(result.status, "passed");
    assert.equal(result.catalogue.courses[0].recordings[0].mediaAccess.status, "unproven");
    assert.equal(result.catalogue.courses[0].recordings[0].mediaPath, undefined);
    assert.equal(hashes, 0);
  });
test("lexical foreign/profile/runtime values are rejected before following filesystem aliases", () => {
  const roots = [
    { logical: "/alias/course", canonical: "/owned/course" },
    { logical: "/alias/media", canonical: "/owned/media" },
  ];
  for (const path of [
    "/foreign/Lecture.mp4",
    "/alias/media/.runtime/tool",
    "/profile/cookies",
    "file:///owned/course/Lecture.mp4",
    "/alias/course/../../profile/cookies",
  ])
    assert.equal(catalogueMediaPath(path, roots), null);
  assert.equal(catalogueMediaPath("/alias/course/Lecture.mp4", roots), "/owned/course/Lecture.mp4");
});
test("configured course aliases normalize only their positively bound root", async (t) => {
  const f = await fixture(t),
    alias = join(f.root, "course-alias");
  await symlink(f.config.courses[0].destination, alias);
  f.config.courses[0].destination = alias;
  const q = JSON.parse(await readFile(f.queuePath));
  q.queue[0].placement.destination = alias;
  q.queue[0].media.video.path = join(alias, "Lecture.mp4");
  await writeFile(f.queuePath, JSON.stringify(q));
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  assert.equal(result.catalogue.courses[0].recordings[0].mediaPath, f.mediaPath);
});
test("distinct current recordings cannot share a declared or physically aliased media file", async (t) => {
  const f = await fixture(t),
    { mediaRecordingRoot } = await import("../src/media/storage.mjs"),
    q = JSON.parse(await readFile(f.queuePath));
  const id = "content-tree:synthetic-course:item:another",
    otherPath = join(f.config.courses[0].destination, "Other.mp4");
  await link(f.mediaPath, otherPath);
  const other = {
    ...f.job,
    recordingId: id,
    media: { video: { available: true, path: otherPath, audio: true } },
    placement: {
      ...f.job.placement,
      videoPath: "Other.mp4",
      formattedTranscriptPath: "Other.transcript.md",
    },
  };
  q.queue.push(other);
  await writeFile(f.queuePath, JSON.stringify(q));
  const root = mediaRecordingRoot(f.config.media.mediaRoot, id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "transcript.state.json"),
    JSON.stringify({ recordingId: id, media: other.media, stage: "failed" }),
  );
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  assert.ok(
    result.catalogue.courses[0].recordings.every((r) => r.mediaAccess.status === "unproven"),
  );
  assert.ok(result.catalogue.courses[0].recordings.every((r) => !r.mediaPath));
});
for (const mutation of ["changed", "same-byte-replacement", "parent-retarget"])
  test(`${mutation} media after plan refuses publication without promoting links`, async (t) => {
    const f = await fixture(t),
      options = { config: f.config, manifestPath: f.manifestPath };
    assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
    const before = await readFile(f.mediaPath);
    if (mutation === "changed") await writeFile(f.mediaPath, "changed owned bytes");
    else if (mutation === "same-byte-replacement") {
      await rename(f.mediaPath, f.mediaPath + ".retained");
      await writeFile(f.mediaPath, before);
    } else {
      const destination = f.config.courses[0].destination;
      await rename(destination, destination + ".retained");
      await symlink(destination + ".retained", destination);
    }
    const result = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
    assert.equal(result.status, "failed");
    assert.equal(result.evidence.promoted, 0);
  });
for (const mutation of ["changed", "same-byte-replacement"])
  test(`${mutation} media during publication stops before index promotion with truthful partial output`, async (t) => {
    const f = await fixture(t),
      options = { config: f.config, manifestPath: f.manifestPath };
    assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
    let mutated = false;
    const result = await transcriptCatalogue(
      { ...options, mode: "publish" },
      {
        ...f.dependencies,
        afterOutput: async () => {
          if (mutated) return;
          mutated = true;
          if (mutation === "changed") await writeFile(f.mediaPath, "changed during writes");
          else {
            const bytes = await readFile(f.mediaPath);
            await rename(f.mediaPath, f.mediaPath + ".retained");
            await writeFile(f.mediaPath, bytes);
          }
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.evidence.written, 1);
    assert.equal(result.evidence.promoted, 0);
    assert.equal(result.evidence.partialPublication, "retained-managed-publication");
    assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  });
test("media streams use separate bounded counters beyond metadata per-file size", async (t) => {
  const f = await fixture(t);
  await truncate(f.mediaPath, 17 * 1024 ** 2);
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.reads.media.readBytes, 17 * 1024 ** 2);
  assert.ok(result.evidence.reads.readBytes < 1024 ** 2);
  assert.equal(result.evidence.reads.maximumReadBytes, 256 * 1024 ** 2);
});
test("typed media I/O and bounded read refusal fail the operation rather than silently removing access", async (t) => {
  const f = await fixture(t);
  const eio = createCatalogueMediaReads(undefined, {
    openFile: async () => {
      throw Object.assign(new Error("private storage details"), { code: "EIO" });
    },
  });
  let result = await transcriptCatalogue(
    { config: f.config, mode: "inspect" },
    { mediaReads: eio },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].code, "EIO");
  assert.doesNotMatch(JSON.stringify(result), /private storage details/);
  const bounded = createCatalogueMediaReads(undefined, {
    limits: { ...CATALOGUE_MEDIA_LIMITS, fileBytes: 1 },
  });
  result = await transcriptCatalogue(
    { config: f.config, mode: "inspect" },
    { mediaReads: bounded },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].code, "CATALOGUE_MEDIA_LIMIT");
});
test("user-edited source invalidates retained plan and never becomes preferred via media access", async (t) => {
  const f = await fixture(t),
    options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  await writeFile(
    f.sourcePath,
    f.raw.replace("First source words", "Student changed source words"),
  );
  const result = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.promoted, 0);
  const inspected = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(inspected.catalogue.courses[0].recordings[0].preferred, null);
  assert.equal(inspected.catalogue.courses[0].recordings[0].mediaAccess.status, "verified");
  assert.equal(inspected.catalogue.courses[0].recordings[0].media.complete, false);
});
test("managed index access links publish verify repeat idempotently without source or user-index overwrite", async (t) => {
  const f = await fixture(t),
    options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  let result = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.retainedMediaAccess, 1);
  const index = join(f.config.courses[0].destination, "Transcript editions/index.md"),
    body = await readFile(index, "utf8");
  assert.match(body, /Retained media access: verified/);
  assert.match(body, /Retained media.*Lecture\.mp4/);
  assert.equal((await transcriptCatalogue({ ...options, mode: "verify" })).status, "passed");
  result = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.promoted, 0);
  assert.equal(result.evidence.written, 0);
  await writeFile(index, "Student index edits");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(index, "utf8"), "Student index edits");
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("media lexical exclusion happens before any filesystem inspection or content open", async () => {
  let calls = 0;
  const reader = createCatalogueMediaReads(undefined, {
    inspect: async () => {
      calls++;
      throw new Error("should not inspect");
    },
    canonical: async () => {
      calls++;
      throw new Error("should not follow");
    },
    openFile: async () => {
      calls++;
      throw new Error("should not read");
    },
  });
  await assert.rejects(reader.read("/foreign/recording.mp4", "/owned"), {
    code: "CATALOGUE_MEDIA_PATH_UNSAFE",
  });
  await assert.rejects(reader.read("/owned/../foreign/recording.mp4", "/owned"), {
    code: "CATALOGUE_MEDIA_PATH_UNSAFE",
  });
  assert.equal(calls, 0);
});
test("leaf symlink refuses and replacement at descriptor open reads no media content", async (t) => {
  const f = await fixture(t),
    alias = join(f.config.courses[0].destination, "alias.mp4");
  await symlink(f.mediaPath, alias);
  const reader = createCatalogueMediaReads();
  await assert.rejects(reader.read(alias, f.config.courses[0].destination), {
    code: "CATALOGUE_MEDIA_PATH_UNSAFE",
  });
  let contentReads = 0,
    closed = false;
  const replaced = createCatalogueMediaReads(undefined, {
    openFile: async (...args) => {
      await rename(f.mediaPath, f.mediaPath + ".retained");
      await writeFile(f.mediaPath, "replacement content");
      const handle = await open(...args);
      return {
        stat: () => handle.stat(),
        read: async (...values) => {
          contentReads++;
          return handle.read(...values);
        },
        close: async () => {
          await handle.close();
          closed = true;
        },
      };
    },
  });
  await assert.rejects(replaced.read(f.mediaPath, f.config.courses[0].destination), {
    code: "CATALOGUE_INPUT_CHANGED",
  });
  assert.equal(contentReads, 0);
  assert.equal(closed, true);
});
test("aggregate media budget and hash count refuse without changing metadata budget", async (t) => {
  const f = await fixture(t);
  const size = (await lstat(f.mediaPath)).size;
  const reader = createCatalogueMediaReads(undefined, {
    limits: { ...CATALOGUE_MEDIA_LIMITS, totalBytes: size, hashes: 2 },
  });
  await reader.read(f.mediaPath, f.config.courses[0].destination);
  await assert.rejects(reader.read(f.mediaPath, f.config.courses[0].destination), {
    code: "CATALOGUE_MEDIA_LIMIT",
  });
  assert.equal(reader.evidence().readBytes, size);
  const count = createCatalogueMediaReads(undefined, {
    limits: { ...CATALOGUE_MEDIA_LIMITS, hashes: 1 },
  });
  await count.read(f.mediaPath, f.config.courses[0].destination);
  await assert.rejects(count.read(f.mediaPath, f.config.courses[0].destination), {
    code: "CATALOGUE_MEDIA_LIMIT",
  });
});
for (const kind of ["timeout", "abort"])
  test(`pending descriptor read ${kind} refuses; eventual descriptor cleanup does not turn result green`, async (t) => {
    const f = await fixture(t),
      controller = new globalThis.AbortController();
    let release,
      entered,
      closed = false;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const reader = createCatalogueMediaReads(controller.signal, {
      limits: { ...CATALOGUE_MEDIA_LIMITS, fileTimeoutMs: 500 },
      openFile: async (...args) => {
        const handle = await open(...args);
        return {
          stat: () => handle.stat(),
          read: async () => {
            entered();
            await pending;
            return { bytesRead: 0 };
          },
          close: async () => {
            await handle.close();
            closed = true;
          },
        };
      },
    });
    const operation = reader.read(f.mediaPath, f.config.courses[0].destination);
    const rejected = assert.rejects(operation, {
      code: kind === "timeout" ? "CATALOGUE_MEDIA_READ_TIMEOUT" : "OWNED_ABORT",
    });
    await started;
    if (kind === "abort")
      controller.abort(Object.assign(new Error("owned abort"), { code: "OWNED_ABORT" }));
    await delay(kind === "timeout" ? 550 : 10);
    assert.equal(closed, false);
    release();
    await rejected;
    for (let i = 0; i < 20 && !closed; i++) await delay(5);
    assert.equal(closed, true);
  });
test("in-place same-byte write with restored mtime during publication refuses ctime change", async (t) => {
  const f = await fixture(t),
    options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  const before = await lstat(f.mediaPath),
    bytes = await readFile(f.mediaPath);
  let changed = false;
  const result = await transcriptCatalogue(
    { ...options, mode: "publish" },
    {
      ...f.dependencies,
      afterOutput: async () => {
        if (changed) return;
        changed = true;
        await writeFile(f.mediaPath, bytes);
        await utimes(f.mediaPath, before.atime, before.mtime);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.written, 1);
  assert.equal(result.evidence.promoted, 0);
});
for (const kind of [
  "pending-read",
  "aborted-read",
  "pending-close",
  "close-failure",
  "identity-stat",
  "identity-close",
])
  test(`publication ${kind} persists unknown-cleanup barrier before lock release and blocks subsequent admission`, async (t) => {
    const f = await fixture(t),
      options = { config: f.config, manifestPath: f.manifestPath };
    assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
    let release,
      closed = false,
      releasedWithBarrier = false,
      opens = 0,
      identityContentReads = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const controller = new globalThis.AbortController();
    const reader = createCatalogueMediaReads(controller.signal, {
      limits: { ...CATALOGUE_MEDIA_LIMITS, fileTimeoutMs: 500, cleanupTimeoutMs: 20 },
      openFile: async (...args) => {
        const handle = await open(...args);
        const identityOpen = ++opens === 2;
        return {
          stat: async () => {
            if (identityOpen && kind === "identity-stat") await pending;
            return handle.stat();
          },
          read: async (...values) => {
            if (identityOpen) identityContentReads++;
            if (kind === "pending-read" || kind === "aborted-read") {
              if (kind === "aborted-read") controller.abort(new Error("owned abort"));
              await pending;
            }
            return handle.read(...values);
          },
          close: async () => {
            if (kind === "pending-close" || (identityOpen && kind === "identity-close"))
              await pending;
            await handle.close();
            closed = true;
            if (kind === "close-failure") throw new Error("private close details");
          },
        };
      },
    });
    const result = await transcriptCatalogue(
      { ...options, mode: "publish", signal: controller.signal },
      {
        ...f.dependencies,
        mediaReads: reader,
        lock: ({ statePath, run }) =>
          withMediaQueueLock({
            statePath,
            run: async () => {
              try {
                return await run();
              } finally {
                releasedWithBarrier =
                  JSON.parse(await readFile(mediaSafetyPath(statePath))).code ===
                  "MEDIA_FILE_CLEANUP";
              }
            },
          }),
      },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.checks[0].code, "MEDIA_FILE_CLEANUP");
    assert.equal(result.evidence.cleanup, "unconfirmed");
    assert.equal(result.evidence.written, 0);
    assert.equal(result.evidence.promoted, 0);
    assert.equal(releasedWithBarrier, true);
    if (kind.startsWith("identity-")) {
      assert.equal(identityContentReads, 0);
      assert.equal(result.evidence.reads.media.identityChecks, 1);
    }
    assert.doesNotMatch(JSON.stringify(result), /private close details/);
    assert.equal(
      (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).checks[0].code,
      "MEDIA_SAFETY_BARRIER",
    );
    release();
    for (let i = 0; i < 30 && !closed; i++) await delay(5);
    assert.equal(closed, true);
    assert.equal(
      JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
      "MEDIA_FILE_CLEANUP",
    );
  });
test("pending parent identity I/O is bounded and cannot return positive after its deadline", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const reader = createCatalogueMediaReads(undefined, {
    limits: { ...CATALOGUE_MEDIA_LIMITS, fileTimeoutMs: 10, timeoutMs: 20, cleanupTimeoutMs: 10 },
    inspect: async () => {
      await pending;
      return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 1 };
    },
  });
  await assert.rejects(reader.assertParents({ parents: [{ path: "/owned", dev: 1, ino: 1 }] }), {
    code: "MEDIA_FILE_CLEANUP",
  });
  release();
  await delay(5);
  await assert.rejects(reader.assertParents({ parents: [] }), { code: "CATALOGUE_MEDIA_LIMIT" });
});
for (const kind of ["same-bytes", "changed-bytes"])
  test(`identity check refuses regular leaf replacement during descriptor stat (${kind})`, async (t) => {
    const f = await fixture(t),
      options = { config: f.config, manifestPath: f.manifestPath };
    assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
    const bytes = await readFile(f.mediaPath);
    let opens = 0,
      replaced = false,
      identityReads = 0;
    const reader = createCatalogueMediaReads(undefined, {
      openFile: async (...args) => {
        const handle = await open(...args),
          identityOpen = ++opens === 2;
        return {
          stat: async () => {
            const info = await handle.stat();
            if (identityOpen && !replaced) {
              replaced = true;
              await rename(f.mediaPath, f.mediaPath + ".retained");
              await writeFile(f.mediaPath, kind === "same-bytes" ? bytes : "replacement bytes");
            }
            return info;
          },
          read: async (...values) => {
            if (identityOpen) identityReads++;
            return handle.read(...values);
          },
          close: () => handle.close(),
        };
      },
    });
    const result = await transcriptCatalogue(
      { ...options, mode: "publish" },
      { ...f.dependencies, mediaReads: reader },
    );
    assert.equal(replaced, true);
    assert.equal(result.status, "failed");
    assert.equal(result.checks[0].code, "CATALOGUE_INPUT_CHANGED");
    assert.equal(result.evidence.written, 0);
    assert.equal(result.evidence.promoted, 0);
    assert.equal(identityReads, 0);
    assert.deepEqual(await readFile(f.mediaPath + ".retained"), bytes);
  });
