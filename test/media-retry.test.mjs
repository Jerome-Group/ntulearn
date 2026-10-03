import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers";
import test from "node:test";
import { EPHEMERAL_MEDIA_JOB_FIELDS, mediaQueuePath } from "../src/media/queue.mjs";
import { createMediaOutcome } from "../src/media/outcome.mjs";
import { resultUpdate } from "../src/media/worker-state.mjs";
import { updateMediaQueueJob } from "../src/media/queue.mjs";
import { withMediaQueueLock } from "../src/media/lock.mjs";
import { assertMediaSafetyAdmission, mediaSafetyPath } from "../src/media/safety.mjs";
import { writeAtomically } from "../src/atomic.mjs";
import {
  retryMediaJobs,
  readRetryQueueMetadata,
  MEDIA_RETRY_CONFIRMATION,
} from "../src/media/retry.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-retry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const course = {
    key: "FIXTURE",
    courseId: "_1_1",
    destination: join(root, "course"),
    mediaMode: "active",
  };
  const config = { statePath: join(root, "state.json"), courses: [course] };
  const job = {
    recordingId: "media-gallery:_1_1:fixture",
    courseKey: course.key,
    courseId: course.courseId,
    title: "private fixture",
    provider: "kaltura",
    providerReference: "entry:fixture",
    disposition: "recording",
    classificationEvidence: "media",
    stage: "failed",
    verdict: "red",
    complete: false,
    retryable: false,
    attempts: 3,
    lastError: "prior failure",
    limitations: ["prior failure"],
    sourceSha256: "a".repeat(64),
    formattedSha256: "b".repeat(64),
    artifacts: {
      rawTranscript: join(root, "raw.json"),
      state: join(root, "transcript.state.json"),
    },
    placement: { destination: course.destination, statusPath: "fixture.media-status.md" },
  };
  await mkdir(course.destination);
  await mkdir(join(root, "media-queue"));
  await writeFile(job.artifacts.rawTranscript, "original source");
  await writeFile(join(course.destination, "student.md"), "student edit");
  const path = mediaQueuePath(config.statePath, course.key);
  async function save(queue = [job], extra = {}) {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        courseKey: course.key,
        courseId: course.courseId,
        complete: true,
        verdict: "green",
        queue,
        updatedAt: "2026-10-03T00:00:00.000Z",
        ...extra,
      }),
    );
  }
  await save();
  const options = { config, courseKey: course.key, selector: "failed" };
  return { root, course, config, job, path, save, options };
}

test("plan writes nothing; confirmed apply preserves history and originals; repeat is idempotent", async (context) => {
  const f = await fixture(context);
  const before = await readFile(f.path);
  const plan = await retryMediaJobs({ ...f.options, mode: "plan" });
  assert.equal(plan.status, "passed");
  assert.equal(plan.evidence.selected, 1);
  assert.equal(plan.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), before);
  const missing = await retryMediaJobs({ ...f.options, mode: "apply", confirmation: true });
  assert.equal(missing.status, "blocked");
  assert.deepEqual(await readFile(f.path), before);
  const applied = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(applied.status, "passed");
  assert.equal(applied.evidence.changed, 1);
  const after = JSON.parse(await readFile(f.path));
  const next = after.queue[0];
  assert.equal(next.retryable, true);
  assert.deepEqual(next.limitations.slice(0, 1), f.job.limitations);
  const retained = { ...next };
  delete retained.retryable;
  delete retained.limitations;
  const original = { ...f.job };
  delete original.retryable;
  delete original.limitations;
  assert.deepEqual(retained, original);
  assert.equal(await readFile(f.job.artifacts.rawTranscript, "utf8"), "original source");
  assert.equal(await readFile(join(f.course.destination, "student.md"), "utf8"), "student edit");
  const saved = await readFile(f.path);
  const repeated = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(repeated.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), saved);
  assert.doesNotMatch(
    JSON.stringify(applied),
    /private fixture|entry:fixture|_1_1|prior failure|original source/,
  );
});

test("realistic large queue metadata does not spend one transcript address budget", async (context) => {
  const f = await fixture(context);
  await f.save(
    Array.from({ length: 600 }, (_, index) => ({
      ...f.job,
      recordingId: `media-gallery:_1_1:fixture-${index}`,
      artifacts: {
        video: "/anonymous/media/lecture.mp4",
        audio: "/anonymous/media/lecture.wav",
        rawTranscript: "/anonymous/media/lecture.json",
        formattedTranscript: "/anonymous/course/lecture.md",
      },
    })),
  );
  const before = await readFile(f.path);
  const result = await retryMediaJobs({ ...f.options, mode: "plan" });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.selected, 600);
  assert.deepEqual(await readFile(f.path), before);
});

test("raw duplicate unsafe strings and credential keys remain refused after JSON overwrite", async (context) => {
  const f = await fixture(context);
  const safe = (await readFile(f.path)).toString();
  for (const extra of [
    '"note":"https://private.invalid/?token=secret","note":"safe"',
    '"note":"signature=secret","note":0',
    '"token":"secret","token":null',
    '"access_token":"secret","access_token":false',
    '"requestHeaders":{"Authorization":"secret"},"requestHeaders":{}',
  ]) {
    await writeFile(f.path, safe.replace("{", `{${extra},`));
    const before = await readFile(f.path);
    const result = await retryMediaJobs({ ...f.options, mode: "plan" });
    assert.notEqual(result.status, "passed");
    assert.equal(result.evidence.changed, 0);
    assert.doesNotMatch(JSON.stringify(result), /private.invalid|secret|Authorization/);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("large harmless metadata cannot override incomplete discovery refusal", async (context) => {
  const f = await fixture(context);
  await f.save([f.job], { complete: false });
  const result = await retryMediaJobs({ ...f.options, mode: "plan" });
  assert.equal(result.checks[0].code, "MEDIA_RETRY_QUEUE_UNAVAILABLE");
  assert.equal(result.evidence.changed, 0);
});

for (const stage of ["open", "metadata", "read", "close", "close-failed"]) {
  test(`retry retains actionable cleanup and restart refusal for ${stage}`, async (context) => {
    const f = await fixture(context);
    const body = await readFile(f.path);
    let release,
      reads = 0,
      metadata = 0,
      closes = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    context.after(() => release());
    const info = { isFile: () => true, size: body.length, mtimeMs: 1 };
    const handle = {
      stat: async () => {
        metadata++;
        if (stage === "metadata") await pending;
        return info;
      },
      read: async (buffer) => {
        reads++;
        if (stage === "read") await pending;
        if (reads > 1) return { bytesRead: 0 };
        body.copy(buffer);
        return { bytesRead: body.length };
      },
      close: async () => {
        closes++;
        if (stage === "close") await pending;
        if (stage === "close-failed") throw Error("private.invalid signature=secret");
      },
    };
    const result = await retryMediaJobs(
      { ...f.options, mode: "plan" },
      {
        read: (path) =>
          readRetryQueueMetadata(path, {
            timeoutMs: 20,
            openQueue: async () => {
              if (stage === "open") await pending;
              return handle;
            },
          }),
      },
    );
    assert.equal(result.checks[0].code, "MEDIA_FILE_CLEANUP");
    assert.equal(result.evidence.cleanup, "unconfirmed");
    assert.equal(result.evidence.safetyUnconfirmed, true);
    assert.equal(result.evidence.containmentRequired, true);
    assert.equal(result.evidence.barrierPersistence, "passed");
    assert.match(result.checks[0].action, /Retain external containment/);
    assert.doesNotMatch(JSON.stringify(result), /private.invalid|signature=secret/);
    assert.deepEqual(await readFile(f.path), body);
    const barrier = JSON.parse(await readFile(mediaSafetyPath(f.config.statePath)));
    assert.equal(barrier.code, "MEDIA_FILE_CLEANUP");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closes, 1);
    assert.equal(
      stage === "open"
        ? metadata
        : stage === "metadata"
          ? reads
          : stage === "read"
            ? metadata
            : closes,
      stage === "open" || stage === "metadata" ? 0 : 1,
    );
    const program = `import { retryMediaJobs } from ${JSON.stringify(new URL("../src/media/retry.mjs", import.meta.url).href)}; const result = await retryMediaJobs(${JSON.stringify({ ...f.options, mode: "plan" })}); process.stdout.write(JSON.stringify(result)); process.exitCode = result.exitCode;`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).checks[0].code, "MEDIA_RETRY_SAFETY_BARRIER");
    assert.equal(child.stderr, "");
  });
}

test("settled expired retry read stays red and admits no later metadata I/O", async (context) => {
  const f = await fixture(context);
  let reads = 0,
    closes = 0;
  const result = await retryMediaJobs(
    { ...f.options, mode: "plan" },
    {
      read: (path) =>
        readRetryQueueMetadata(path, {
          timeoutMs: 20,
          openQueue: async () => ({
            stat: async () => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              return { isFile: () => true, size: 1, mtimeMs: 1 };
            },
            read: async () => {
              reads++;
              return { bytesRead: 0 };
            },
            close: async () => {
              closes++;
            },
          }),
        }),
    },
  );
  assert.notEqual(result.status, "passed");
  assert.equal(result.checks[0].code, "MEDIA_RETRY_READ_TIMEOUT");
  assert.equal(result.evidence.changed, 0);
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  assert.equal(result.evidence.containmentRequired, undefined);
});

test("failed cleanup barrier persistence remains explicit external containment", async (context) => {
  const f = await fixture(context);
  const result = await retryMediaJobs(
    { ...f.options, mode: "plan" },
    {
      read: (path) =>
        readRetryQueueMetadata(path, {
          openQueue: async () => ({
            stat: async () => ({ isFile: () => true, size: 0, mtimeMs: 1 }),
            read: async () => ({ bytesRead: 0 }),
            close: async () => {
              throw Error("secret close failure");
            },
          }),
        }),
      persistBarrier: async ({ error }) => {
        throw Object.assign(Error("private barrier path", { cause: error }), {
          code: "MEDIA_SAFETY_BARRIER_WRITE",
        });
      },
    },
  );
  assert.equal(result.checks[0].code, "MEDIA_SAFETY_BARRIER_WRITE");
  assert.equal(result.evidence.barrierPersistence, "failed");
  assert.equal(result.evidence.containmentRequired, true);
  assert.equal(result.evidence.cleanupCode, "MEDIA_FILE_CLEANUP");
  assert.doesNotMatch(JSON.stringify(result), /secret close|private barrier path/);
});

for (const barrierWritable of [true, false]) {
  test(`durable retry publication retains cleanup when barrier storage is ${barrierWritable ? "available" : "refused"}`, async (context) => {
    const f = await fixture(context);
    const originalSource = await readFile(f.job.artifacts.rawTranscript);
    const original = JSON.parse(await readFile(f.path));
    let result;
    try {
      result = await retryMediaJobs(
        {
          ...f.options,
          mode: "apply",
          confirmation: MEDIA_RETRY_CONFIRMATION,
        },
        {
          updateJob: async ({ write }) => {
            await write(
              f.path,
              JSON.stringify({ ...original, queue: [{ ...f.job, retryable: true }] }),
            );
            if (!barrierWritable) await chmod(f.root, 0o500);
            throw Object.assign(Error("private.invalid token=secret"), {
              code: "MEDIA_FILE_CLEANUP",
              globalSafety: true,
            });
          },
        },
      );
    } finally {
      await chmod(f.root, 0o700);
    }
    assert.equal(result.status, "failed");
    assert.equal(result.evidence.changed, 1);
    assert.equal(
      result.checks[0].code,
      barrierWritable ? "MEDIA_FILE_CLEANUP" : "MEDIA_SAFETY_BARRIER_WRITE",
    );
    assert.equal(result.evidence.containmentRequired, true);
    assert.equal(result.evidence.cleanupCode, "MEDIA_FILE_CLEANUP");
    assert.equal(result.evidence.barrierPersistence, barrierWritable ? "passed" : "failed");
    assert.doesNotMatch(JSON.stringify(result), /private.invalid|token=secret/);
    assert.equal(JSON.parse(await readFile(f.path)).queue[0].retryable, true);
    assert.deepEqual(await readFile(f.job.artifacts.rawTranscript), originalSource);
    let owner;
    if (barrierWritable)
      assert.equal(
        JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
        "MEDIA_FILE_CLEANUP",
      );
    else {
      owner = await readFile(join(f.root, "media-queue.lock", "owner.json"));
      assert.equal(
        await readFile(join(f.root, "media-queue.lock", "safety-armed"), "utf8"),
        "v1\n",
      );
    }
    const options = { ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION };
    const program = `import { retryMediaJobs } from ${JSON.stringify(new URL("../src/media/retry.mjs", import.meta.url).href)}; const result = await retryMediaJobs(${JSON.stringify(options)}); process.stdout.write(JSON.stringify(result)); process.exitCode = result.exitCode;`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(child.status, 2);
    assert.equal(
      JSON.parse(child.stdout).checks[0].code,
      barrierWritable ? "MEDIA_RETRY_SAFETY_BARRIER" : "MEDIA_RETRY_LOCK_HELD",
    );
    assert.equal(child.stderr, "");
    if (owner)
      assert.deepEqual(await readFile(join(f.root, "media-queue.lock", "owner.json")), owner);
  });
}

test("retry raw metadata retains byte, scalar-count and nesting limits", async (context) => {
  const f = await fixture(context);
  const safe = (await readFile(f.path)).toString();
  for (const extra of [
    `"note":${JSON.stringify("x".repeat(4 * 1024 * 1024))}`,
    `"note":[${Array(100001).fill("0").join(",")}]`,
    `"note":${"[".repeat(17)}0${"]".repeat(17)}`,
    '"note":1e999,"note":0',
    '"access\\u005ftoken":"secret","access_token":null',
  ]) {
    await writeFile(f.path, safe.replace("{", `{${extra},`));
    const before = await readFile(f.path);
    const result = await retryMediaJobs({ ...f.options, mode: "plan" });
    assert.notEqual(result.status, "passed");
    assert.equal(result.evidence.changed, 0);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("explicit selectors reject unresolved, excluded, withdrawn and completed targets", async (context) => {
  const f = await fixture(context);
  for (const patch of [
    { disposition: "unresolved" },
    { disposition: "non-recording", classificationEvidence: "document" },
    { withdrawn: true },
    { complete: true },
    { stage: "queued" },
  ]) {
    await f.save([{ ...f.job, ...patch }]);
    const before = await readFile(f.path);
    const result = await retryMediaJobs({
      ...f.options,
      selector: f.job.recordingId,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.notEqual(result.status, "passed");
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("busy lock is refused before queue reads and preserves its owner", async (context) => {
  const f = await fixture(context);
  let reads = 0;
  await withMediaQueueLock({
    statePath: f.config.statePath,
    run: async () => {
      const owner = await readFile(join(f.root, "media-queue.lock", "owner.json"));
      const result = await retryMediaJobs(
        { ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION },
        {
          readQueue: async () => {
            reads++;
            throw Error("must not read");
          },
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(reads, 0);
      assert.deepEqual(await readFile(join(f.root, "media-queue.lock", "owner.json")), owner);
    },
  });
});

test("missing, malformed, duplicate and foreign queues fail closed", async (context) => {
  const f = await fixture(context);
  for (const mutation of [
    () => rm(f.path),
    () => writeFile(f.path, "{"),
    () => f.save([f.job, f.job]),
    () => f.save([{ ...f.job, courseId: "_foreign_1" }]),
    () => f.save([f.job], { courseId: "_foreign_1" }),
  ]) {
    await mutation();
    const result = await retryMediaJobs({
      ...f.options,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.notEqual(result.status, "passed");
    await f.save();
  }
});

test("unconfirmed safety evidence never grants permission or exposes private error detail", async (context) => {
  const f = await fixture(context);
  for (const patch of [
    { globalSafety: true },
    { lastError: "MEDIA_PROCESS_CLEANUP https://private.invalid/?token=secret" },
    { limitations: ["owned process-group cleanup could not be confirmed"] },
    { safetyFailure: "MEDIA_PROCESS_CLEANUP" },
    { safetyFailure: "MEDIA_BROWSER_CLEANUP" },
    { safetyFailure: "unknown-safety" },
    { error: { cause: { globalSafety: true } } },
  ]) {
    await f.save([{ ...f.job, ...patch }]);
    const before = await readFile(f.path);
    const result = await retryMediaJobs({
      ...f.options,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.notEqual(result.status, "passed");
    assert.deepEqual(await readFile(f.path), before);
    assert.doesNotMatch(JSON.stringify(result), /private.invalid|secret|_1_1/);
  }
});

test("failed selector grants only recording permission in a mixed queue", async (context) => {
  const f = await fixture(context);
  const unrelated = [
    {
      ...f.job,
      recordingId: "media-gallery:_1_1:excluded",
      disposition: "non-recording",
      classificationEvidence: "document",
    },
    { ...f.job, recordingId: "media-gallery:_1_1:unknown", disposition: "unresolved" },
    { ...f.job, recordingId: "media-gallery:_1_1:queued", stage: "queued" },
    { ...f.job, recordingId: "media-gallery:_1_1:complete", stage: "complete", complete: true },
  ];
  await f.save([f.job, ...unrelated]);
  const result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.selected, 1);
  assert.deepEqual(JSON.parse(await readFile(f.path)).queue.slice(1), unrelated);
});

test("all-course preflight refuses unavailable second queue before granting first permission", async (context) => {
  const f = await fixture(context);
  const second = {
    ...f.course,
    key: "SECOND",
    courseId: "_2_1",
    destination: join(f.root, "second"),
  };
  await mkdir(second.destination);
  const before = await readFile(f.path);
  const result = await retryMediaJobs({
    ...f.options,
    config: { ...f.config, courses: [f.course, second] },
    courseKey: "all",
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.notEqual(result.status, "passed");
  assert.equal(result.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), before);
});

test("all-course apply includes enabled courses and ignores disabled queues", async (context) => {
  const f = await fixture(context);
  const second = {
    ...f.course,
    key: "SECOND",
    courseId: "_2_1",
    destination: join(f.root, "second"),
    mediaMode: "pilot",
  };
  await mkdir(second.destination);
  const job = {
    ...f.job,
    recordingId: "content-tree:_2_1:second",
    courseKey: second.key,
    courseId: second.courseId,
    placement: { destination: second.destination, statusPath: "second.media-status.md" },
  };
  await writeFile(
    mediaQueuePath(f.config.statePath, second.key),
    JSON.stringify({
      version: 1,
      courseKey: second.key,
      courseId: second.courseId,
      complete: true,
      queue: [job],
    }),
  );
  const config = {
    ...f.config,
    courses: [f.course, second, { ...f.course, key: "OFF", mediaMode: "off" }],
  };
  const result = await retryMediaJobs({
    ...f.options,
    config,
    courseKey: "all",
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.courses, 2);
  assert.equal(result.evidence.changed, 2);
});

test("unsafe later selected job prevents any earlier permission write", async (context) => {
  const f = await fixture(context);
  await f.save([f.job, { ...f.job, recordingId: "media-gallery:_1_1:unsafe", globalSafety: true }]);
  const before = await readFile(f.path);
  const result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.notEqual(result.status, "passed");
  assert.equal(result.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), before);
});

test("partial status failure reports durable permission and repeated apply does not rewrite", async (context) => {
  const f = await fixture(context);
  const result = await retryMediaJobs(
    { ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION },
    {
      write: async (path, body) => {
        if (path !== f.path)
          throw Object.assign(new Error("private storage failure"), { code: "EIO" });
        await writeAtomically(path, body);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.changed, 1);
  assert.equal(JSON.parse(await readFile(f.path)).queue[0].retryable, true);
  assert.doesNotMatch(JSON.stringify(result), /private storage/);
  const before = await readFile(f.path);
  const repeated = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(repeated.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), before);
});

test("queue symlinks and signed legacy evidence are refused without changing unrelated bytes", async (context) => {
  const f = await fixture(context);
  await f.save([{ ...f.job, sourceUrl: "https://private.invalid/?token=secret" }]);
  const before = await readFile(f.path);
  let result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.notEqual(result.status, "passed");
  assert.deepEqual(await readFile(f.path), before);
  await rm(f.path);
  const retained = join(f.root, "retained.json");
  await writeFile(retained, before);
  await symlink(retained, f.path);
  result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.notEqual(result.status, "passed");
  assert.deepEqual(await readFile(retained), before);
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|secret/);
});

test("invalid UTF-8 queue bytes are refused rather than rewritten with replacement characters", async (context) => {
  const f = await fixture(context);
  const original = await readFile(f.path);
  const marker = Buffer.from("private fixture");
  const start = original.indexOf(marker);
  const corrupted = Buffer.concat([
    original.subarray(0, start),
    Buffer.from([0xff]),
    original.subarray(start + 1),
  ]);
  await writeFile(f.path, corrupted);
  const result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.notEqual(result.status, "passed");
  assert.deepEqual(await readFile(f.path), corrupted);
});

test("target changes after preflight are refused before a retry permission write", async (context) => {
  const f = await fixture(context);
  let reads = 0;
  const result = await retryMediaJobs(
    { ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION },
    {
      read: async (path) => {
        if (++reads === 2) await f.save([{ ...f.job, withdrawn: true }]);
        return readFile(path);
      },
    },
  );
  assert.notEqual(result.status, "passed");
  assert.equal(result.evidence.changed, 0);
  const next = JSON.parse(await readFile(f.path)).queue[0];
  assert.equal(next.withdrawn, true);
  assert.equal(next.retryable, false);
});

test("explicit historical capacity and permission codes can be rearmed without clearing history", async (context) => {
  const f = await fixture(context);
  for (const code of ["ENOSPC", "EACCES", "EIO", "ENODEV", "EPERM", "EROFS"]) {
    const original = {
      ...f.job,
      lastError: `${code} fixture`,
      error: { cause: { code, globalSafety: true } },
    };
    await f.save([original]);
    const result = await retryMediaJobs({
      ...f.options,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.equal(result.status, "passed");
    const next = JSON.parse(await readFile(f.path)).queue[0];
    assert.equal(next.retryable, true);
    assert.equal(next.lastError, original.lastError);
    assert.deepEqual(next.error, original.error);
    assert.equal(result.evidence.retrySucceeded, "unrun");
  }
});

test("explicit disabled course and incomplete discovery authority refuse retry", async (context) => {
  const f = await fixture(context);
  for (const variant of ["disabled", "incomplete"]) {
    await f.save([f.job], { complete: variant !== "incomplete" });
    const config =
      variant === "disabled"
        ? { ...f.config, courses: [{ ...f.course, mediaMode: "off" }] }
        : f.config;
    const before = await readFile(f.path);
    const result = await retryMediaJobs({
      ...f.options,
      config,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.changed, 0);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("multiple failed targets preserve already permitted history and case-compatible course identity", async (context) => {
  const f = await fixture(context);
  const second = { ...f.job, recordingId: "content-tree:_1_1:second" };
  const permitted = { ...f.job, recordingId: "content-tree:_1_1:permitted", retryable: true };
  await f.save([f.job, second, permitted], { courseKey: "fixture" });
  const result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.selected, 3);
  assert.equal(result.evidence.changed, 2);
  assert.equal(result.evidence.alreadyRetryable, 1);
  const record = JSON.parse(await readFile(f.path));
  assert.equal(record.courseKey, "fixture");
  assert.deepEqual(record.queue[2], permitted);
  const before = await readFile(f.path);
  const repeated = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(repeated.evidence.changed, 0);
  assert.deepEqual(await readFile(f.path), before);
});

test("fresh plan/apply instances refuse retained, malformed and symlink safety latches without reading or clearing them", async (context) => {
  const f = await fixture(context);
  const latch = mediaSafetyPath(f.config.statePath);
  for (const body of [
    JSON.stringify({ version: 1, code: "MEDIA_PROCESS_CLEANUP" }),
    "malformed safety evidence",
  ]) {
    await writeFile(latch, body);
    const before = await readFile(f.path);
    for (const mode of ["plan", "apply"]) {
      const result = await retryMediaJobs(
        { ...f.options, mode, confirmation: MEDIA_RETRY_CONFIRMATION },
        { readQueue: async () => assert.fail("latch must block before queue reads") },
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0].code, "MEDIA_RETRY_SAFETY_BARRIER");
      assert.deepEqual(await readFile(f.path), before);
      assert.equal(await readFile(latch, "utf8"), body);
    }
    await rm(latch);
  }
  const retained = join(f.root, "retained-latch");
  await writeFile(retained, "retained bytes");
  await symlink(retained, latch);
  const result = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(result.status, "blocked");
  assert.equal(await readFile(retained, "utf8"), "retained bytes");
});

test("unreadable latch seam and safety in an opted-out course block before selected permission writes", async (context) => {
  const f = await fixture(context);
  const before = await readFile(f.path);
  let result = await retryMediaJobs(
    { ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION },
    {
      assertAdmission: (options) =>
        assertMediaSafetyAdmission({
          ...options,
          inspect: async () => {
            throw Object.assign(new Error("private permission failure"), { code: "EACCES" });
          },
        }),
    },
  );
  assert.equal(result.status, "blocked");
  assert.doesNotMatch(JSON.stringify(result), /private permission/);
  const off = { ...f.course, key: "OFF", courseId: "_2_1", mediaMode: "off" };
  const otherJob = {
    ...f.job,
    recordingId: "media-gallery:_2_1:safety",
    courseKey: off.key,
    courseId: off.courseId,
    safetyFailure: "MEDIA_BROWSER_CLEANUP",
  };
  await writeFile(
    mediaQueuePath(f.config.statePath, off.key),
    JSON.stringify({
      version: 1,
      courseKey: off.key,
      courseId: off.courseId,
      complete: true,
      queue: [otherJob],
    }),
  );
  for (const mode of ["plan", "apply"]) {
    result = await retryMediaJobs({
      ...f.options,
      config: { ...f.config, courses: [f.course, off] },
      mode,
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.changed, 0);
    assert.deepEqual(await readFile(f.path), before);
    assert.equal(
      JSON.parse(await readFile(mediaQueuePath(f.config.statePath, off.key))).queue[0]
        .safetyFailure,
      "MEDIA_BROWSER_CLEANUP",
    );
  }
});

test("a new Node process refuses the durable cleanup barrier after restart", async (context) => {
  const f = await fixture(context);
  const latch = mediaSafetyPath(f.config.statePath);
  await writeFile(latch, JSON.stringify({ version: 1, code: "MEDIA_PROCESS_CLEANUP" }));
  const queueBefore = await readFile(f.path);
  const latchBefore = await readFile(latch);
  const program = `import { retryMediaJobs } from ${JSON.stringify(new URL("../src/media/retry.mjs", import.meta.url).href)}; const result = await retryMediaJobs(${JSON.stringify({ ...f.options, mode: "apply", confirmation: MEDIA_RETRY_CONFIRMATION })}); process.stdout.write(JSON.stringify(result)); process.exitCode = result.exitCode;`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).checks[0].code, "MEDIA_RETRY_SAFETY_BARRIER");
  assert.equal(child.stderr, "");
  assert.deepEqual(await readFile(f.path), queueBefore);
  assert.deepEqual(await readFile(latch), latchBefore);
});

test("every shared ephemeral queue field refuses retry without publishing private values", async (context) => {
  const f = await fixture(context);
  assert.equal(Object.isFrozen(EPHEMERAL_MEDIA_JOB_FIELDS), true);
  for (const field of EPHEMERAL_MEDIA_JOB_FIELDS) {
    await f.save([{ ...f.job, [field]: "private fixture credential" }]);
    const before = await readFile(f.path);
    const result = await retryMediaJobs({
      ...f.options,
      mode: "apply",
      confirmation: MEDIA_RETRY_CONFIRMATION,
    });
    assert.notEqual(result.status, "passed", field);
    assert.equal(result.evidence.changed, 0);
    assert.deepEqual(await readFile(f.path), before);
    assert.doesNotMatch(JSON.stringify(result), /private fixture credential/);
  }
});

test("canonical outcome state artifact survives queue publication and retry", async (context) => {
  const f = await fixture(context);
  const at = new Date("2026-10-04T00:00:00.000Z");
  const result = await createMediaOutcome({
    appearance: f.job,
    clock: () => at,
    storage: {
      write: async ({ filename }) => ({ path: join(f.root, filename), status: "written" }),
    },
  }).persist({
    providerName: "kaltura",
    media: { video: { available: false }, audio: { available: false } },
    source: null,
    artifacts: {},
    limitations: ["prior failure"],
    complete: false,
    stage: "failed",
    retryable: false,
  });
  await updateMediaQueueJob({
    statePath: f.config.statePath,
    courseKey: f.course.key,
    course: f.course,
    recordingId: f.job.recordingId,
    update: resultUpdate(result, at),
    now: () => at,
  });
  const before = await readFile(f.path);
  const original = JSON.parse(before).queue[0];
  assert.equal(original.artifacts.state, join(f.root, "transcript.state.json"));
  const plan = await retryMediaJobs({ ...f.options, mode: "plan" });
  assert.equal(plan.status, "passed");
  assert.equal(plan.evidence.selected, 1);
  assert.deepEqual(await readFile(f.path), before);
  const apply = await retryMediaJobs({
    ...f.options,
    mode: "apply",
    confirmation: MEDIA_RETRY_CONFIRMATION,
  });
  assert.equal(apply.status, "passed");
  assert.equal(apply.evidence.changed, 1);
  const next = JSON.parse(await readFile(f.path)).queue[0];
  assert.deepEqual(next.artifacts, original.artifacts);
  assert.equal(next.attempts, original.attempts);
  assert.equal(next.stage, "failed");
  assert.equal(next.complete, false);
  assert.equal(next.retryable, true);
});

test("state artifact exception refuses other contexts, types and overwritten unsafe values", async (context) => {
  const f = await fixture(context);
  const path = join(f.root, "transcript.state.json");
  const safeArtifact = JSON.stringify({ state: path });
  for (const artifacts of [
    { state: null },
    { state: false },
    { state: 1 },
    { state: {} },
    { state: [] },
    { state: { path } },
    { state: "transcript.state.json" },
    { state: join(f.root, "other.json") },
    { State: path },
    { state: `${f.root}/bad\0/transcript.state.json` },
    { state: "https://private.invalid/transcript.state.json" },
    { state: "//private.invalid/transcript.state.json" },
    { state: `${f.root}/transcript.state.json?state=secret` },
  ]) {
    await f.save([{ ...f.job, artifacts }]);
    for (const mode of ["plan", "apply"]) {
      const before = await readFile(f.path);
      const result = await retryMediaJobs({
        ...f.options,
        mode,
        confirmation: MEDIA_RETRY_CONFIRMATION,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0].code, "MEDIA_RETRY_QUEUE_UNSAFE");
      assert.deepEqual(await readFile(f.path), before);
      assert.doesNotMatch(JSON.stringify(result), /private.invalid|secret/);
    }
  }
  await f.save([{ ...f.job, artifacts: { state: path } }]);
  const safe = await readFile(f.path, "utf8");
  const variants = [
    safe.replace("{", `{"state":${JSON.stringify(path)},`),
    safe.replace('"artifacts":', `"state":${JSON.stringify(path)},"artifacts":`),
    safe.replace('"artifacts":', `"other":{"state":${JSON.stringify(path)}},"artifacts":`),
    safe.replace(safeArtifact, `{"state":null,"state":${JSON.stringify(path)}}`),
    safe.replace(safeArtifact, `{"state":"secret","st\\u0061te":${JSON.stringify(path)}}`),
    safe.replace(safeArtifact, `{"state":{},"state":${JSON.stringify(path)}}`),
    safe.replace('"artifacts":', '"artifacts":{"state":"secret"},"artifacts":'),
    safe.replace("{", '{"queue":[{"artifacts":{"state":"secret"}}],'),
    safe.replace(safeArtifact, `{"state":${JSON.stringify(path)},"token":null}`),
    safe.replace(
      safeArtifact,
      `{"state":${JSON.stringify(path)},"note":"https://private.invalid/?state=secret"}`,
    ),
    safe.replace(
      safeArtifact,
      `{"state":${JSON.stringify(path)},"note":"https://private.invalid/?st%61te=secret"}`,
    ),
    safe.replace(safeArtifact, `{"state":${JSON.stringify(path)},"note":"state&#61;secret"}`),
  ];
  for (const body of variants) {
    assert.notEqual(body, safe);
    await writeFile(f.path, body);
    for (const mode of ["plan", "apply"]) {
      const result = await retryMediaJobs({
        ...f.options,
        mode,
        confirmation: MEDIA_RETRY_CONFIRMATION,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0].code, "MEDIA_RETRY_QUEUE_UNSAFE");
      assert.deepEqual(await readFile(f.path, "utf8"), body);
    }
  }
});
