import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile, rename, lstat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runMediaQueue } from "../src/media/worker.mjs";
import { mediaLockAdmissionPath } from "../src/media/lock-admission.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { persistMediaSafetyBarrier } from "../src/media/safety.mjs";
import { withMediaQueueLock, mediaQueueLockPath } from "../src/media/lock.mjs";

test("serializes media queue runs across lock contenders", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-lock-"));
  const statePath = join(root, "state.json");
  let release;
  const first = withMediaQueueLock({
    statePath,
    run: () => new Promise((resolve) => (release = resolve)),
  });

  while (!release) await setImmediate();
  await assert.rejects(
    withMediaQueueLock({ statePath, run: async () => "second" }),
    (error) => error.code === "MEDIA_QUEUE_LOCK_HELD",
  );

  release("first");
  assert.equal(await first, "first");
  assert.equal(
    await withMediaQueueLock({ statePath, run: async () => "after-release" }),
    "after-release",
  );
});

test("barrier-write uncertainty retains pre-armed owned lock beyond stale age", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-lock-safety-"));
  const statePath = join(root, "state.json");
  const started = new Date("2026-01-01T00:00:00Z");
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      now: () => started,
      run: async () => {
        throw Object.assign(new Error("synthetic barrier-write uncertainty"), {
          code: "MEDIA_SAFETY_BARRIER_WRITE",
        });
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  const ownerPath = join(mediaQueueLockPath(statePath), "owner.json");
  const before = await readFile(ownerPath);
  assert.equal(JSON.parse(before).safetyContainment, "armed");
  let admitted = 0;
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      now: () => new Date("2026-01-04T00:00:00Z"),
      run: async () => {
        admitted++;
      },
    }),
    { code: "MEDIA_QUEUE_LOCK_HELD" },
  );
  assert.equal(admitted, 0);
  assert.deepEqual(await readFile(ownerPath), before);
});

test("ordinary failed owned run still releases its pre-armed receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-lock-failure-"));
  const statePath = join(root, "state.json");
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      run: async () => {
        throw new Error("ordinary failure");
      },
    }),
    /ordinary failure/,
  );
  assert.equal(await withMediaQueueLock({ statePath, run: async () => "admitted" }), "admitted");
});

test("unclean armed receipt is never automatically reclaimed or rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-lock-unclean-"));
  const statePath = join(root, "state.json"),
    lockPath = mediaQueueLockPath(statePath);
  await mkdir(lockPath);
  const original = JSON.stringify({
    token: "synthetic-owner",
    startedAt: "2026-01-01T00:00:00Z",
    safetyContainment: "armed",
  });
  await writeFile(join(lockPath, "owner.json"), original);
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      now: () => new Date("2026-01-04T00:00:00Z"),
      run: async () => assert.fail("not admitted"),
    }),
    { code: "MEDIA_QUEUE_LOCK_HELD" },
  );
  assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), original);
});

for (const owner of ["malformed", "null", ""]) {
  test(`durable armed marker refuses stale reclaim with ${owner || "missing"} owner metadata`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-owner-unknown-"));
    const statePath = join(root, "state.json"),
      lockPath = mediaQueueLockPath(statePath);
    await mkdir(lockPath);
    await writeFile(join(lockPath, "safety-armed"), "v1\n");
    if (owner) await writeFile(join(lockPath, "owner.json"), owner);
    await assert.rejects(
      withMediaQueueLock({
        statePath,
        now: () => new Date("2026-01-04T00:00:00Z"),
        run: async () => assert.fail("unknown owner never admits"),
      }),
      { code: "MEDIA_QUEUE_LOCK_HELD" },
    );
    assert.equal(await readFile(join(lockPath, "safety-armed"), "utf8"), "v1\n");
  });
}

test("positively recognized legacy stale receipt retains its existing reclaim policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-legacy-"));
  const statePath = join(root, "state.json"),
    lockPath = mediaQueueLockPath(statePath);
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ token: "legacy-owner", startedAt: "2026-01-01T00:00:00Z" }),
  );
  assert.equal(
    await withMediaQueueLock({
      statePath,
      now: () => new Date("2026-01-04T00:00:00Z"),
      run: async () => "legacy admitted",
    }),
    "legacy admitted",
  );
});

test("actual barrier-storage refusal retains the owned safety lock before later ordinary admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-barrier-storage-"));
  const parent = join(root, "occupied-parent");
  await mkdir(parent);
  const statePath = join(parent, "state.json"),
    lockPath = join(root, "owned-lock");
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      lockPath,
      run: async () => {
        await rename(parent, parent + "-retained");
        await writeFile(parent, "synthetic occupied path");
        return persistMediaSafetyBarrier({ statePath, error: { code: "MEDIA_FILE_CLEANUP" } });
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      lockPath,
      run: async () => assert.fail("barrier storage uncertainty must not admit"),
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  assert.equal(await readFile(join(lockPath, "safety-armed"), "utf8"), "v1\n");
});

test("foreign replacement owner cannot be deleted or reported as confirmed release", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-foreign-"));
  const statePath = join(root, "state.json"),
    lockPath = mediaQueueLockPath(statePath);
  const foreign = JSON.stringify({ token: "foreign-owner", startedAt: "2026-01-01T00:00:00Z" });
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      run: async () => {
        await writeFile(join(lockPath, "owner.json"), foreign);
        return "ordinary result";
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), foreign);
});

test("ordinary worker admission refuses an aged armed receipt without acquiring any job", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-worker-refusal-"));
  const statePath = join(root, "state.json"),
    lockPath = mediaQueueLockPath(statePath);
  await mkdir(lockPath);
  await writeFile(join(lockPath, "safety-armed"), "v1\n");
  await writeFile(join(lockPath, "owner.json"), "unreadable malformed owner");
  let acquired = 0;
  const digest = await runMediaQueue({
    statePath,
    mode: "manual",
    now: () => new Date("2026-01-04T00:00:00Z"),
    courses: [{ key: "TEST", courseId: "_1_1", mediaMode: "pilot" }],
    preflight: async () => {},
    runJob: async () => {
      acquired++;
    },
  });
  assert.equal(acquired, 0);
  assert.equal(digest.verdict, "yellow");
  assert.deepEqual(digest.admissionRefusal, {
    code: "MEDIA_QUEUE_LOCK_HELD",
    ownership: "unconfirmed",
    action: "await-owned-settlement-or-owner-qualified-recovery",
  });
  assert.doesNotMatch(digest.message, /another run is active/i);
  assert.equal(await readFile(join(lockPath, "safety-armed"), "utf8"), "v1\n");
});

for (const stage of ["marker-stat", "owner-read"]) {
  test(`pending foreign legacy ${stage} is globally contained before a later admission`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-probe-pending-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const statePath = join(root, "state.json"),
      lockPath = mediaQueueLockPath(statePath);
    await mkdir(lockPath);
    const owner = JSON.stringify({ token: "legacy-owner", startedAt: "2026-01-01T00:00:00Z" });
    await writeFile(join(lockPath, "owner.json"), owner);
    let release,
      probes = 0,
      jobs = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release(stage === "marker-stat" ? undefined : { bytesRead: 0 }));
    const options = {
      statePath,
      probeTimeoutMs: 100,
      now: () => new Date("2026-01-04T00:00:00Z"),
      run: async () => {
        jobs++;
      },
    };
    if (stage === "marker-stat")
      options.inspectSafetyMarker = async () => {
        probes++;
        await pending;
        throw Object.assign(new Error("absent fixture marker"), { code: "ENOENT" });
      };
    else
      options.openOwner = async () => ({
        stat: async () => ({ isFile: () => true, size: 0 }),
        read: async () => {
          probes++;
          return pending;
        },
        close: async () => {},
      });
    await assert.rejects(withMediaQueueLock(options), { code: "MEDIA_FILE_CLEANUP" });
    assert.equal(
      JSON.parse(await readFile(mediaSafetyPath(statePath), "utf8")).code,
      "MEDIA_FILE_CLEANUP",
    );
    await assert.rejects(withMediaQueueLock({ ...options, inspectSafetyMarker: lstat }), {
      code: "MEDIA_SAFETY_BARRIER",
    });
    assert.equal(jobs, 0);
    assert.equal(probes, 1);
    assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), owner);
  });
}

test("failed barrier write preserves preprobe marker and foreign owner across storage recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-lock-preprobe-write-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot);
  t.after(async () => {
    await chmod(stateRoot, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const statePath = join(stateRoot, "state.json"),
    lockPath = join(root, "foreign-lock");
  await mkdir(lockPath);
  const original = JSON.stringify({ token: "foreign-owner", startedAt: "2026-01-01T00:00:00Z" });
  await writeFile(join(lockPath, "owner.json"), original);
  let release,
    probes = 0,
    jobs = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      lockPath,
      probeTimeoutMs: 250,
      inspectSafetyMarker: async () => {
        probes++;
        await chmod(stateRoot, 0o500);
        await pending;
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      now: () => new Date("2026-01-04T00:00:00Z"),
      run: async () => {
        jobs++;
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  await chmod(stateRoot, 0o700);
  assert.ok((await lstat(mediaLockAdmissionPath(statePath))).isFile());
  await assert.rejects(
    withMediaQueueLock({
      statePath,
      lockPath,
      run: async () => {
        jobs++;
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER" },
  );
  assert.equal(jobs, 0);
  assert.equal(probes, 1);
  assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), original);
});

test("initial admission marker storage refusal fails before any foreign metadata or work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-admission-initial-refusal-"));
  const parent = join(root, "occupied-parent");
  await writeFile(parent, "synthetic occupied parent");
  let probes = 0,
    jobs = 0;
  await assert.rejects(
    withMediaQueueLock({
      statePath: join(parent, "state.json"),
      lockPath: join(root, "foreign-lock"),
      inspectSafetyMarker: async () => {
        probes++;
      },
      run: async () => {
        jobs++;
      },
    }),
    { code: "MEDIA_SAFETY_BARRIER_WRITE" },
  );
  assert.equal(probes, 0);
  assert.equal(jobs, 0);
  assert.equal(await readFile(parent, "utf8"), "synthetic occupied parent");
});
