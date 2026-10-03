import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { readFile, writeFile, readdir, mkdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { historicalTranscripts } from "../src/media/historical.mjs";
import { transcriptCatalogue } from "../src/media/catalogue.mjs";
import { mediaQueueLockPath } from "../src/media/lock.mjs";
async function fixture(t) {
  const f = await historicalFixture(t);
  await historicalTranscripts({ config: f.config, manifestPath: f.manifestPath, mode: "plan" });
  await historicalTranscripts(
    { config: f.config, manifestPath: f.manifestPath, mode: "apply" },
    f.dependencies,
  );
  f.catalogue = join(f.root, "catalogue.json");
  f.options = { config: f.config, manifestPath: f.catalogue };
  f.index = join(f.config.courses[0].destination, "Transcript editions/index.md");
  assert.equal((await transcriptCatalogue({ ...f.options, mode: "plan" })).status, "passed");
  return f;
}
test("interruption at every immutable/promoted publication boundary preserves outputs and resumes identical plan", async (t) => {
  for (const cut of [1, 2, 3, 4, 5]) {
    const f = await fixture(t);
    let steps = 0;
    const result = await transcriptCatalogue(
      { ...f.options, mode: "publish" },
      {
        ...f.dependencies,
        afterOutput: () => {
          if (++steps === cut) throw new Error("synthetic interruption");
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.ok(result.evidence.written + result.evidence.promoted > 0);
    assert.equal(result.evidence.partialPublication, "retained-managed-publication");
    const retry = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
    assert.equal(retry.status, "passed");
    assert.equal((await transcriptCatalogue({ ...f.options, mode: "verify" })).status, "passed");
    assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  }
});
test("managed index update keeps an immutable beforeimage; later user edit refuses any replacement", async (t) => {
  const f = await fixture(t);
  await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
  const prior = await readFile(f.index, "utf8");
  const queue = JSON.parse(await readFile(f.queuePath));
  queue.queue[0].title = "Readable new title";
  await writeFile(f.queuePath, JSON.stringify(queue));
  const options = { config: f.config, manifestPath: join(f.root, "next-plan.json") };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const manifest = JSON.parse(await readFile(options.manifestPath));
  assert.equal(
    await readFile(
      join(
        f.config.courses[0].destination,
        "Transcript editions/.catalogue-history",
        manifest.id,
        "before.md",
      ),
      "utf8",
    ),
    prior,
  );
  await writeFile(f.index, "student catalogue");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(f.index, "utf8"), "student catalogue");
});
test("unknown occupied index, changed inputs, lost producer and foreign lock refuse", async (t) => {
  for (const kind of ["unknown", "raw", "receipt", "lock"]) {
    const f = await fixture(t);
    if (kind === "unknown") await writeFile(f.index, "Unknown index");
    if (kind === "raw") await writeFile(f.sourcePath, f.raw + " ");
    if (kind === "receipt") await writeFile(f.index + ".catalogue.json", "foreign receipt");
    if (kind === "lock") {
      const path = mediaQueueLockPath(f.config.statePath);
      await mkdir(path);
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({ token: "foreign", startedAt: new Date().toISOString() }),
      );
    }
    const result = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
    assert.ok(["failed", "blocked"].includes(result.status));
    assert.equal(result.evidence.promoted, 0);
    if (kind === "unknown") assert.equal(await readFile(f.index, "utf8"), "Unknown index");
  }
});
test("input and parent races during reserve check refuse before index publication, with no owned stage destruction", async (t) => {
  for (const kind of ["parent", "source", "symlink"]) {
    const f = await fixture(t);
    let acted = false;
    const result = await transcriptCatalogue(
      { ...f.options, mode: "publish" },
      {
        ...f.dependencies,
        createCapacity: async () => ({
          check: async () => {
            if (acted) return;
            acted = true;
            if (kind === "source") await writeFile(f.sourcePath, f.raw + " ");
            else {
              const parent = join(f.config.courses[0].destination, "Transcript editions");
              await rename(parent, parent + ".retained");
              if (kind === "symlink") await symlink(parent + ".retained", parent);
              else await mkdir(parent);
            }
          },
        }),
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.evidence.promoted, 0);
  }
});
test("retained unknown history cannot be consumed as ownership on a resumed publication", async (t) => {
  const f = await fixture(t);
  let first = true;
  await transcriptCatalogue(
    { ...f.options, mode: "publish" },
    {
      ...f.dependencies,
      afterOutput: () => {
        if (first) {
          first = false;
          throw new Error("interrupt");
        }
      },
    },
  );
  const manifest = JSON.parse(await readFile(f.catalogue));
  const history = join(
    f.config.courses[0].destination,
    "Transcript editions/.catalogue-history",
    manifest.id,
  );
  await writeFile(join(history, "journal.json"), "foreign journal");
  assert.equal(
    (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(join(history, "journal.json"), "utf8"), "foreign journal");
  assert.ok((await readdir(history)).includes("journal.json"));
});

test("edited plan rehash cannot forge the positive plan receipt or gain index replacement", async (t) => {
  const f = await fixture(t),
    { historicalDigest } = await import("../src/media/historical-files.mjs");
  const manifest = JSON.parse(await readFile(f.catalogue));
  delete manifest.id;
  manifest.selections = [{ recordingId: f.job.recordingId, sha256: "a".repeat(64) }];
  manifest.id = historicalDigest(JSON.stringify(manifest)).slice(0, 24);
  await writeFile(f.catalogue, JSON.stringify(manifest));
  const result = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.promoted, 0);
});
test("interrupt during reserve aborts without publication and retains all original bytes", async (t) => {
  const f = await fixture(t),
    controller = new globalThis.AbortController();
  const result = await transcriptCatalogue(
    { ...f.options, mode: "publish", signal: controller.signal },
    {
      ...f.dependencies,
      createCapacity: async () => ({
        check: async () => controller.abort(new Error("Owner abort")),
      }),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.promoted, 0);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.raw);
});

test("unknown staging replacement refuses cleanup and retains foreign bytes rather than unlinking", async (t) => {
  const f = await fixture(t);
  let replaced = false,
    foreign;
  const result = await transcriptCatalogue(
    { ...f.options, mode: "publish" },
    {
      ...f.dependencies,
      createCapacity: async () => ({
        check: async () => {
          if (replaced) return;
          const folder = join(f.config.courses[0].destination, "Transcript editions");
          const names = await readdir(folder);
          const part = names.find((name) => name.startsWith("index.md.part-"));
          if (!part) return;
          replaced = true;
          foreign = join(folder, part);
          await rename(foreign, foreign + ".retained-owned");
          await writeFile(foreign, "Foreign replacement stage");
        },
      }),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].code, "CATALOGUE_CLEANUP_UNCERTAIN");
  assert.equal(await readFile(foreign, "utf8"), "Foreign replacement stage");
  assert.ok(result.evidence.written > 0);
  assert.equal(result.evidence.promoted, 0);
});

test("resumed journal deadline reports fixed stage/cap and retains an unchanged plan for eventual explicit resume", async (t) => {
  const f = await fixture(t);
  let steps = 0;
  const interrupted = await transcriptCatalogue(
    { ...f.options, mode: "publish" },
    {
      ...f.dependencies,
      afterOutput: () => {
        if (++steps === 4) throw new Error("synthetic interruption");
      },
    },
  );
  assert.equal(interrupted.checks[0].code, "CATALOGUE_EVIDENCE_INVALID");
  const manifest = JSON.parse(await readFile(f.catalogue));
  const history = join(
    f.config.courses[0].destination,
    "Transcript editions/.catalogue-history",
    manifest.id,
  );
  const journal = await readFile(join(history, "journal.json"));
  const plan = await readFile(f.catalogue);
  let time = 1000;
  const limited = await transcriptCatalogue(
    { ...f.options, mode: "publish" },
    {
      ...f.dependencies,
      now: () => time,
      afterOutput: () => {
        time += 120000;
      },
    },
  );
  assert.equal(limited.checks[0].code, "CATALOGUE_LIMIT");
  assert.equal(limited.evidence.stage, "publication");
  assert.deepEqual(limited.evidence.limit, {
    kind: "elapsed-ms",
    observed: 120000,
    maximum: 120000,
  });
  assert.equal(limited.evidence.reads.elapsedMs, 120000);
  assert.equal(limited.evidence.reads.timeoutMs, 120000);
  assert.equal(limited.evidence.existing, 1);
  assert.ok(limited.evidence.snapshotChecks > 0);
  assert.ok(limited.evidence.snapshotInputChecks > 0);
  assert.ok(limited.evidence.snapshotScans > 0);
  assert.match(limited.checks[0].action, /explicitly retrying the same plan/);
  assert.deepEqual(await readFile(join(history, "journal.json")), journal);
  assert.deepEqual(await readFile(f.catalogue), plan);
  const resumed = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(resumed.status, "passed");
  assert.equal((await transcriptCatalogue({ ...f.options, mode: "verify" })).status, "passed");
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.raw);
});

test("refused manifest bytes expose fixed cap and stage without private filenames", async (t) => {
  const f = await fixture(t);
  const bytes = 16 * 1024 ** 2 + 1;
  await writeFile(f.catalogue, Buffer.alloc(bytes, 0x20));
  const result = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(result.checks[0].code, "CATALOGUE_LIMIT");
  assert.equal(result.evidence.stage, "manifest-read");
  assert.deepEqual(result.evidence.limit, {
    kind: "file-bytes",
    observed: bytes,
    maximum: bytes - 1,
  });
  assert.equal(result.evidence.reads.readBytes, 0);
  assert.equal(result.evidence.written, 0);
  assert.equal(result.evidence.promoted, 0);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal((await readFile(f.catalogue)).length, bytes);
});

test("public limit evidence retains only validated numeric counters and fixed kinds", async (t) => {
  const f = await fixture(t);
  for (const [kind, expected] of [
    ["read-bytes", { kind: "read-bytes", observed: 9, maximum: 8 }],
    ["private arbitrary kind", undefined],
  ]) {
    const result = await transcriptCatalogue(
      { ...f.options, mode: "publish" },
      {
        ...f.dependencies,
        admission: async () => {
          throw Object.assign(new Error("private raw exception"), {
            code: "HISTORICAL_READ_LIMIT",
            limit: { kind, observed: 9, maximum: 8, path: f.root, id: "private-id" },
          });
        },
      },
    );
    assert.equal(result.checks[0].code, "CATALOGUE_LIMIT");
    assert.equal(result.evidence.stage, "admission");
    assert.deepEqual(result.evidence.limit, expected);
    for (const secret of [f.root, "private-id", "private raw exception", "private arbitrary kind"])
      assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("verified catalogue reuse performs no staging and retains initial/final snapshot checks", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const manifest = JSON.parse(await readFile(f.catalogue)),
    target = manifest.targets[0];
  const { catalogueReads } = await import("../src/media/catalogue-files.mjs");
  const { publishCatalogueTarget } = await import("../src/media/catalogue-publication.mjs");
  const reads = catalogueReads(),
    originalProbe = reads.probe;
  let stagingProbes = 0,
    checks = 0;
  reads.probe = async (operation) => {
    const result = await originalProbe(operation);
    const folders = [
      join(f.config.courses[0].destination, "Transcript editions"),
      join(f.config.courses[0].destination, "Transcript editions/.catalogue-history", manifest.id),
    ];
    for (const folder of folders)
      if ((await readdir(folder)).some((name) => name.includes(".part-"))) stagingProbes++;
    return result;
  };
  const requests = [],
    progress = { written: 0, existing: 0, promoted: 0 };
  await publishCatalogueTarget({
    target,
    planId: manifest.id,
    reads,
    progress,
    check: async () => {
      checks++;
    },
    checkCapacity: async (request) => {
      requests.push(request);
    },
    checkExisting: async (request) => {
      requests.push(request);
    },
  });
  assert.equal(stagingProbes, 0);
  assert.equal(checks, 2);
  assert.equal(progress.written, 0);
  assert.equal(progress.promoted, 0);
  assert.equal(progress.existing, 4);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.boundary, target.boundary);
    assert.equal(request.bytes, (await readFile(request.path)).length);
  }
});

for (const boundary of ["new-stage", "final-snapshot"])
  test(`source change after verified journal reuse refuses at ${boundary} and retains originals`, async (t) => {
    const f = await fixture(t);
    if (boundary === "new-stage") {
      let first = true;
      const interrupted = await transcriptCatalogue(
        { ...f.options, mode: "publish" },
        {
          ...f.dependencies,
          afterOutput: () => {
            if (first) {
              first = false;
              throw new Error("fixture interruption");
            }
          },
        },
      );
      assert.equal(interrupted.status, "failed");
    } else
      assert.equal(
        (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
        "passed",
      );
    const manifest = JSON.parse(await readFile(f.catalogue)),
      history = join(
        f.config.courses[0].destination,
        "Transcript editions/.catalogue-history",
        manifest.id,
      );
    const journal = await readFile(join(history, "journal.json"));
    let changed = false;
    const changedSource = f.raw.replace("First", "Other");
    const result = await transcriptCatalogue(
      { ...f.options, mode: "publish" },
      {
        ...f.dependencies,
        afterOutput: async (path) => {
          if (!changed && path === join(history, "journal.json")) {
            changed = true;
            await writeFile(f.sourcePath, changedSource);
          }
        },
      },
    );
    assert.equal(changed, true);
    assert.equal(result.checks[0].code, "CATALOGUE_INPUT_CHANGED");
    assert.equal(result.evidence.written, 0);
    assert.equal(result.evidence.promoted, 0);
    assert.deepEqual(await readFile(join(history, "journal.json")), journal);
    assert.equal(await readFile(f.originalPath, "utf8"), f.original);
    assert.equal(await readFile(f.sourcePath, "utf8"), changedSource);
    if (boundary === "new-stage") {
      for (const name of ["index.md", "complete.json"])
        await assert.rejects(readFile(join(history, name)), { code: "ENOENT" });
      assert.equal(
        (await readdir(history)).some((name) => name.includes(".part-")),
        false,
      );
    }
  });

test("explicit repeated publication retains full per-course/global snapshots with fewer synthetic checks", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const repeated = await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies);
  assert.equal(repeated.status, "passed");
  assert.equal(repeated.evidence.written, 0);
  assert.equal(repeated.evidence.promoted, 0);
  assert.equal(repeated.evidence.snapshotChecks, 2 + 2 * f.config.courses.length);
  assert.ok(repeated.evidence.snapshotInputChecks > 0);
  assert.ok(repeated.evidence.snapshotScans > 0);
  assert.equal(repeated.evidence.reads.timeoutMs, 120000);
});

test("positive reuse preserves foreign edited history and refuses parent retarget before staging", async (t) => {
  for (const kind of ["history-index", "complete", "history-parent"]) {
    const f = await fixture(t);
    assert.equal(
      (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
      "passed",
    );
    const manifest = JSON.parse(await readFile(f.catalogue)),
      history = join(
        f.config.courses[0].destination,
        "Transcript editions/.catalogue-history",
        manifest.id,
      ),
      index = await readFile(f.index);
    let editedPath;
    const dependencies = { ...f.dependencies };
    if (kind === "history-parent") {
      let acted = false;
      dependencies.createCapacity = async () => ({
        check: async (request) => {
          if (acted || request.path !== join(history, "journal.json")) return;
          acted = true;
          await rename(history, history + ".retained");
          await symlink(history + ".retained", history);
        },
      });
    } else {
      editedPath = join(history, kind === "history-index" ? "index.md" : "complete.json");
      await writeFile(editedPath, "Student foreign history bytes");
    }
    const refused = await transcriptCatalogue({ ...f.options, mode: "publish" }, dependencies);
    assert.equal(refused.status, "failed");
    assert.equal(refused.evidence.written, 0);
    assert.equal(refused.evidence.promoted, 0);
    assert.deepEqual(await readFile(f.index), index);
    if (editedPath)
      assert.equal(await readFile(editedPath, "utf8"), "Student foreign history bytes");
    else assert.ok((await readdir(history + ".retained")).includes("journal.json"));
    assert.equal(
      (await readdir(kind === "history-parent" ? history + ".retained" : history)).some((name) =>
        name.includes(".part-"),
      ),
      false,
    );
    assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  }
});

test("existing output reserve callback profile retarget refuses before byte reuse", async (t) => {
  const f = await fixture(t);
  f.config.profilePath = join(f.root, "profile");
  await mkdir(f.config.profilePath);
  const alternate = join(f.root, "alternate-profile");
  await mkdir(alternate);
  const options = { config: f.config, manifestPath: join(f.root, "profile-catalogue.json") };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const index = await readFile(f.index);
  let acted = false;
  const refused = await transcriptCatalogue(
    { ...options, mode: "publish" },
    {
      ...f.dependencies,
      createCapacity: async () => ({
        check: async (request) => {
          if (acted || !request.path?.endsWith("journal.json")) return;
          acted = true;
          await rename(f.config.profilePath, f.config.profilePath + ".retained");
          await symlink(alternate, f.config.profilePath);
        },
      }),
    },
  );
  assert.equal(acted, true);
  assert.equal(refused.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY");
  assert.equal(refused.evidence.written, 0);
  assert.equal(refused.evidence.promoted, 0);
  assert.deepEqual(await readFile(f.index), index);
});

test("descriptor-bound existing journal identity refuses identical replacement after positive byte read", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await transcriptCatalogue({ ...f.options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const manifest = JSON.parse(await readFile(f.catalogue)),
    target = manifest.targets[0],
    path = join(
      f.config.courses[0].destination,
      "Transcript editions/.catalogue-history",
      manifest.id,
      "journal.json",
    );
  const { catalogueReads } = await import("../src/media/catalogue-files.mjs");
  const { publishCatalogueTarget } = await import("../src/media/catalogue-publication.mjs");
  const reads = catalogueReads(),
    originalRead = reads.read;
  let replaced = false;
  reads.read = async (candidate, options) => {
    const file = await originalRead(candidate, options);
    if (!replaced && candidate === path && options?.includeIdentity) {
      replaced = true;
      await rename(path, path + ".retained");
      await writeFile(path, file.content);
    }
    return file;
  };
  const progress = { written: 0, existing: 0, promoted: 0 },
    before = await readFile(path);
  await assert.rejects(
    publishCatalogueTarget({
      target,
      planId: manifest.id,
      reads,
      progress,
      check: async () => {},
      checkCapacity: async () => {},
      checkExisting: async () => {},
    }),
    { code: "RECOVERY_INPUT_CHANGED" },
  );
  assert.equal(replaced, true);
  assert.equal(progress.written, 0);
  assert.equal(progress.promoted, 0);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readFile(path + ".retained"), before);
});
