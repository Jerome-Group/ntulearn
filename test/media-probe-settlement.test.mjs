import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaQueue } from "../src/media/worker.mjs";
import { assertMediaArtifactPath } from "../src/media/storage.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { closeMediaProbeHandle } from "../src/media/probe-settlement.mjs";
import { mediaArtifactEvidenceUpdate } from "../src/media/transcript-evidence.mjs";
import { withCapacityDeadline } from "../src/media/capacity-deadline.mjs";

test("pending admitted probe refuses cleanup instead of treating its logical deadline as settlement", async (t) => {
  let release,
    settled = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await assert.rejects(
    withCapacityDeadline(
      async () => {
        await pending;
        settled = true;
      },
      { timeoutMs: 20 },
    ),
    (error) => error.code === "MEDIA_FILE_CLEANUP" && error.globalSafety === true,
  );
  assert.equal(settled, false);
});

test("positively settled expired probe retains its original timeout and discards late success", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.setTimeout(release, 30);
  await assert.rejects(
    withCapacityDeadline(() => pending, { timeoutMs: 20 }),
    (error) => error.code === "MEDIA_CAPACITY_TIMEOUT" && error.globalSafety === true,
  );
});

test("descriptor close failure takes cleanup precedence after the original deadline", async () => {
  await assert.rejects(
    withCapacityDeadline(
      async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
        await closeMediaProbeHandle({
          close: async () => {
            throw new Error("synthetic close refusal");
          },
        });
      },
      { timeoutMs: 20 },
    ),
    (error) => error.code === "MEDIA_FILE_CLEANUP",
  );
});

test("expiry checkpoint prevents admitting a later metadata operation", async () => {
  let metadataReads = 0;
  await assert.rejects(
    withCapacityDeadline(
      async (active) => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
        active();
        metadataReads++;
      },
      { timeoutMs: 20 },
    ),
    (error) => error.code === "MEDIA_CAPACITY_TIMEOUT",
  );
  assert.equal(metadataReads, 0);
});

function completedEvidenceJob() {
  return {
    recordingId: "content-tree:_1_1:lecture",
    complete: true,
    stage: "complete",
    transcript: { complete: true, sourceKind: "provider" },
    artifacts: { formattedTranscript: "/synthetic/course/lecture.md" },
  };
}

for (const stage of ["metadata", "read", "close"]) {
  test(`artifact evidence retains unconfirmed ${stage} cleanup and admits no later I/O`, async (t) => {
    let release,
      reads = 0,
      closes = 0,
      entered = false;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const info = { isFile: () => true, size: 1, dev: 1, ino: 1, mtimeMs: 1 };
    const io = {
      assertPath: async () => {},
      stat: async () => info,
      open: async () => ({
        stat: async () => {
          if (stage === "metadata") {
            entered = true;
            await pending;
          }
          return info;
        },
        read: async (buffer) => {
          reads++;
          if (stage === "read") {
            entered = true;
            await pending;
          }
          buffer[0] = 97;
          return { bytesRead: reads === 1 ? 1 : 0 };
        },
        close: async () => {
          closes++;
          if (stage === "close") {
            entered = true;
            await pending;
          }
        },
      }),
    };
    await assert.rejects(
      mediaArtifactEvidenceUpdate(completedEvidenceJob(), {
        course: { destination: "/synthetic/course" },
        io,
        probeTimeoutMs: 20,
      }),
      (error) => error.code === "MEDIA_FILE_CLEANUP" && error.globalSafety === true,
    );
    assert.equal(entered, true);
    assert.equal(
      stage === "metadata" ? reads : closes,
      stage === "metadata" ? 0 : stage === "read" ? 0 : 1,
    );
  });
}

test("pending alias metadata settlement refuses without opening an artifact", async (t) => {
  let release,
    opens = 0,
    resolutions = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release("/synthetic/course"));
  await assert.rejects(
    mediaArtifactEvidenceUpdate(
      {
        ...completedEvidenceJob(),
        placement: { destination: "/synthetic/alias", formattedTranscriptPath: "lecture.md" },
        artifacts: { formattedTranscript: "/synthetic/alias/lecture.md" },
      },
      {
        course: { destination: "/synthetic/course" },
        probeTimeoutMs: 20,
        resolveRoot: async () => {
          resolutions++;
          return pending;
        },
        io: {
          open: async () => {
            opens++;
          },
          stat: async () => {},
          assertPath: async () => {},
        },
      },
    ),
    (error) => error.code === "MEDIA_FILE_CLEANUP",
  );
  assert.equal(resolutions, 1);
  assert.equal(opens, 0);
});

test("pre-job evidence persistence cleanup barriers a later worker admission before lock release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-probe-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const course = { key: "TEST", courseId: "_1_1", mediaMode: "pilot" };
  let releases = 0,
    runs = 0,
    updates = 0;
  const job = { ...completedEvidenceJob(), artifacts: {} };
  const options = {
    statePath,
    courses: [course],
    mode: "manual",
    preflight: async () => {},
    readQueue: async () => ({ record: { complete: true, queue: [job] } }),
    updateJob: async () => {
      updates++;
      throw Object.assign(new Error("synthetic descriptor cleanup"), {
        code: "MEDIA_FILE_CLEANUP",
      });
    },
    runJob: async () => {
      runs++;
    },
    write: async () => {},
    lock: async ({ run }) => {
      try {
        return await run();
      } finally {
        assert.equal(
          JSON.parse(await readFile(mediaSafetyPath(statePath), "utf8")).code,
          "MEDIA_FILE_CLEANUP",
        );
        releases++;
      }
    },
  };
  const first = await runMediaQueue(options);
  assert.equal(first.globalStop, true);
  assert.equal(releases, 1);
  const second = await runMediaQueue(options);
  assert.equal(second.globalStop, true);
  assert.equal(releases, 2);
  assert.equal(updates, 1);
  assert.equal(runs, 0);
});

test("expired admitted parent metadata check does not inspect another ancestor", async (t) => {
  let release,
    parents = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release({ isSymbolicLink: () => false }));
  await assert.rejects(
    withCapacityDeadline(
      (active) =>
        assertMediaArtifactPath("/synthetic/course/lecture.md", "/synthetic/course", {
          active,
          inspect: async () => {
            parents++;
            return pending;
          },
        }),
      { timeoutMs: 20 },
    ),
    (error) => error.code === "MEDIA_FILE_CLEANUP",
  );
  release({ isSymbolicLink: () => false });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(parents, 1);
});

test("settled descriptor-close refusal preserves typed cleanup without waiting for a deadline", async () => {
  await assert.rejects(
    mediaArtifactEvidenceUpdate(completedEvidenceJob(), {
      course: { destination: "/synthetic/course" },
      io: {
        assertPath: async () => {},
        open: async () => ({
          stat: async () => ({ isFile: () => true, size: 0 }),
          close: async () => {
            throw Object.assign(new Error("private synthetic close cause"), { code: "EIO" });
          },
        }),
      },
    }),
    (error) => error.code === "MEDIA_FILE_CLEANUP" && error.globalSafety === true,
  );
});

test("alias absence fallback cannot swallow recognized file cleanup failure", async () => {
  await assert.rejects(
    mediaArtifactEvidenceUpdate(
      {
        ...completedEvidenceJob(),
        placement: { destination: "/synthetic/alias", formattedTranscriptPath: "lecture.md" },
        artifacts: { formattedTranscript: "/synthetic/alias/lecture.md" },
      },
      {
        course: { destination: "/synthetic/course" },
        resolveRoot: async () => {
          throw Object.assign(new Error("synthetic alias cleanup"), { code: "MEDIA_FILE_CLEANUP" });
        },
      },
    ),
    (error) => error.code === "MEDIA_FILE_CLEANUP" && error.globalSafety === true,
  );
});
