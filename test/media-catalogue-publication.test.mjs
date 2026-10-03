import assert from "node:assert/strict";
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
