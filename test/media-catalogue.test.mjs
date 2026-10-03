import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historicalFixture } from "./fixtures/historical.mjs";
import { historicalTranscripts } from "../src/media/historical.mjs";
import { transcriptCatalogue } from "../src/media/catalogue.mjs";

async function fixture(t) {
  const f = await historicalFixture(t);
  await historicalTranscripts({ config: f.config, mode: "plan", manifestPath: f.manifestPath });
  await historicalTranscripts(
    { config: f.config, mode: "apply", manifestPath: f.manifestPath },
    f.dependencies,
  );
  return { ...f, manifestPath: join(f.root, "catalogue.json") };
}

test("inspect prefers verified paragraphs, accounts native orphan and disabled course without changing source or queue", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.queuePath);
  const result = await transcriptCatalogue({ mode: "inspect", config: f.config });
  assert.equal(result.status, "passed");
  assert.equal(result.catalogue.courses.length, 2);
  const recording = result.catalogue.courses[0].recordings[0];
  assert.equal(recording.title, "Lecture");
  assert.equal(recording.reading, "verified");
  assert.equal(recording.preferred.kind, "paragraph");
  assert.equal(recording.media.complete, false);
  assert.ok(result.catalogue.unassociated.length >= 1);
  assert.deepEqual(await readFile(f.queuePath), before);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.raw);
});

test("plan publish verify repeat preserve originals and refuse student-edited stable index", async (t) => {
  const f = await fixture(t);
  const options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  assert.equal((await transcriptCatalogue({ ...options, mode: "verify" })).status, "passed");
  const repeated = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
  assert.equal(repeated.status, "passed");
  assert.equal(repeated.evidence.promoted, 0);
  const path = join(f.config.courses[0].destination, "Transcript editions", "index.md");
  assert.match(await readFile(path, "utf8"), /Lecture/);
  await writeFile(path, "Student catalogue edits");
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "failed",
  );
  assert.equal(await readFile(path, "utf8"), "Student catalogue edits");
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
});

test("durable queue review and suspicious source paragraphs stay readable review, never preferred polished garbage", async (t) => {
  const f = await fixture(t),
    queue = JSON.parse(await readFile(f.queuePath));
  queue.queue[0].transcript = {
    reviewRequired: true,
    flags: ["suspicious-repetition"],
    complete: false,
  };
  await writeFile(f.queuePath, JSON.stringify(queue));
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const record = result.catalogue.courses[0].recordings[0];
  assert.equal(record.preferred, null);
  assert.equal(record.reading, "review");
  assert.equal(record.editions[0].reading, "verified");
  assert.deepEqual(record.sourceReview.flags, ["suspicious-repetition"]);
});
test("historical unknown timing remains explicit without inventing acoustic or media readiness", async (t) => {
  const f = await historicalFixture(t);
  delete f.metadata.duration;
  await writeFile(f.metadataPath, JSON.stringify(f.metadata));
  await historicalTranscripts({ config: f.config, manifestPath: f.manifestPath, mode: "plan" });
  await historicalTranscripts(
    { config: f.config, manifestPath: f.manifestPath, mode: "apply" },
    f.dependencies,
  );
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const record = result.catalogue.courses[0].recordings[0];
  assert.equal(record.preferred.timing, "unknown-duration");
  assert.equal(record.sourceReview.acousticVerification, "unrun");
  assert.equal(record.media.complete, false);
});

test("long retained source catalogue executes zero runtime subprocesses and keeps literal operators/uncertainty", async (t) => {
  const f = await historicalFixture(t),
    { historicalDigest } = await import("../src/media/historical-files.mjs");
  const raw = JSON.stringify({
    sourceKind: "provider",
    language: "en",
    segments: Array.from({ length: 1000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: `Example ${i}: x <= ${i + 1}; maybe y != ${i + 2}.`,
    })),
  });
  await writeFile(f.sourcePath, raw);
  f.metadata.sourceSha256 = historicalDigest(raw);
  f.metadata.duration = 1000;
  await writeFile(f.metadataPath, JSON.stringify(f.metadata));
  await historicalTranscripts({ config: f.config, manifestPath: f.manifestPath, mode: "plan" });
  await historicalTranscripts(
    { config: f.config, manifestPath: f.manifestPath, mode: "apply" },
    f.dependencies,
  );
  const childProcess = await import("node:child_process"),
    { syncBuiltinESMExports } = await import("node:module");
  let calls = 0;
  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"])
    t.mock.method(childProcess.default, name, () => {
      calls++;
      throw new Error("Runtime execution prohibited");
    });
  syncBuiltinESMExports();
  let result;
  try {
    result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(result.status, "passed");
  assert.equal(calls, 0);
  const record = result.catalogue.courses[0].recordings[0];
  assert.equal(record.preferred.kind, "paragraph");
  const text = await readFile(record.preferred.path, "utf8");
  assert.match(text, /Example 999: x <= 1000; maybe y != 1001\./);
  assert.doesNotMatch(JSON.stringify(result), /Example 999/);
});

test("checkpoint source-review flags remain terminal for paragraph preference even when queue flag is absent", async (t) => {
  const f = await fixture(t),
    { historicalDigest } = await import("../src/media/historical-files.mjs");
  await writeFile(
    join(f.recordRoot, "transcript.state.json"),
    JSON.stringify({
      recordingId: f.job.recordingId,
      sourceSha256: historicalDigest(f.raw),
      transcript: { reviewRequired: true, flags: ["suspicious-repetition"], complete: false },
    }),
  );
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  const record = result.catalogue.courses[0].recordings[0];
  assert.equal(record.preferred, null);
  assert.equal(record.reading, "review");
  assert.deepEqual(record.sourceReview.flags, ["suspicious-repetition"]);
});

test("all appearances accounted separately; documents and unresolved resources are not lectures", async (t) => {
  const f = await fixture(t),
    queue = JSON.parse(await readFile(f.queuePath));
  queue.queue.push(
    {
      ...f.job,
      recordingId: "document",
      title: "Handout",
      disposition: "non-recording",
      classificationEvidence: "document",
    },
    {
      ...f.job,
      recordingId: "uncertain",
      title: "Unknown resource",
      disposition: "unresolved",
      classificationEvidence: "unknown",
    },
  );
  await writeFile(f.queuePath, JSON.stringify(queue));
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.status, "passed");
  const course = result.catalogue.courses[0];
  assert.deepEqual(course.counts, {
    appearances: 3,
    recordings: 1,
    unresolved: 1,
    nonRecordings: 1,
  });
  assert.equal(course.recordings[0].disposition, "recording");
  assert.equal(course.unresolved[0].classificationEvidence, "unknown");
  const { catalogueMarkdown } = await import("../src/media/catalogue.mjs");
  const markdown = catalogueMarkdown(course, []);
  assert.match(markdown, /## Unresolved appearances/);
  assert.doesNotMatch(markdown, /### Handout|### Unknown resource/);
});

test("local Markdown links retain parentheses within angle-delimited destinations", async (t) => {
  const f = await fixture(t),
    result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  const course = result.catalogue.courses[0];
  course.recordings[0].original = join(f.root, "Lecture ) 1.md");
  const { catalogueMarkdown } = await import("../src/media/catalogue.mjs");
  assert.match(
    catalogueMarkdown(course, []),
    /\[Original derivative\]\(<file:\/\/[^>]*Lecture%20\)%201\.md>\)/,
  );
});

for (const variant of ["direct", "ancestor", "absent-ancestor"])
  test(`profile ${variant} alias refused before inventory file reads`, async (t) => {
    const f = await historicalFixture(t),
      { symlink } = await import("node:fs/promises");
    const alias = join(f.root, "profile-alias");
    await symlink(f.config.media.mediaRoot, alias);
    f.config.profilePath =
      variant === "direct"
        ? alias
        : join(alias, variant === "ancestor" ? "recordings" : "not-created", "profile");
    // An invalid source would expose inventory access if the profile guard ran late.
    await writeFile(f.sourcePath, "PRIVATE invalid transcript");
    const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
    assert.equal(result.status, "failed");
    assert.equal(result.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|profile-alias/);
  });

test("absent separate profile accepted and retargeted physical ancestor refused", async (t) => {
  const f = await fixture(t),
    { mkdir, symlink, unlink } = await import("node:fs/promises");
  const safe = join(f.root, "safe");
  await mkdir(safe);
  const alias = join(f.root, "profile-parent");
  await symlink(safe, alias);
  f.config.profilePath = join(alias, "uncreated-profile");
  const options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  await unlink(alias);
  await symlink(f.config.media.mediaRoot, alias);
  const result = await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies);
  assert.equal(result.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY");
});

test("legacy queue fallback retains recording and pins attempted modern absence", async (t) => {
  const f = await historicalFixture(t),
    { rename } = await import("node:fs/promises"),
    { dirname } = await import("node:path");
  f.config.courses[0].key = "course space";
  const queue = JSON.parse(await readFile(f.queuePath));
  queue.courseKey = "course space";
  queue.queue[0].courseKey = "course space";
  await writeFile(f.queuePath, JSON.stringify(queue));
  await rename(f.queuePath, join(dirname(f.queuePath), "course_space.json"));
  const options = { config: f.config, manifestPath: join(f.root, "catalogue.json") };
  const result = await transcriptCatalogue({ ...options, mode: "inspect" });
  assert.equal(result.status, "passed");
  assert.equal(result.catalogue.courses[0].recordings.length, 1);
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  const plan = JSON.parse(await readFile(options.manifestPath));
  assert.ok(plan.inventory.absences.some((pin) => pin.path.includes("course%20space.json")));
});

test("every immutable and promoted course output checks actual destination bytes; course volume refusal preserves originals", async (t) => {
  const f = await fixture(t),
    options = { config: f.config, manifestPath: f.manifestPath };
  assert.equal((await transcriptCatalogue({ ...options, mode: "plan" })).status, "passed");
  const checks = [];
  const result = await transcriptCatalogue(
    { ...options, mode: "publish" },
    {
      ...f.dependencies,
      createCapacity: async () => ({
        check: async (request) => {
          checks.push(request);
          if (request.bytes > 0) throw Object.assign(new Error("full"), { code: "MEDIA_CAPACITY" });
        },
      }),
    },
  );
  assert.notEqual(result.status, "passed");
  assert.ok(
    checks.some(
      (request) =>
        request.boundary === f.config.courses[0].destination && request.bytes > 0 && request.path,
    ),
  );
  assert.equal(await readFile(f.originalPath, "utf8"), f.original);
  const successChecks = [];
  assert.equal(
    (
      await transcriptCatalogue(
        { ...options, mode: "publish" },
        {
          ...f.dependencies,
          createCapacity: async () => ({ check: async (request) => successChecks.push(request) }),
        },
      )
    ).status,
    "passed",
  );
  const outputs = successChecks.filter((request) => request.bytes > 0);
  for (const name of ["journal.json", "index.md", "index.md.catalogue.json", "complete.json"])
    assert.ok(
      outputs.some(
        (request) =>
          request.path.endsWith(name) && request.boundary === f.config.courses[0].destination,
      ),
    );
  assert.ok(outputs.every((request) => Number.isSafeInteger(request.bytes) && request.bytes > 0));
});

test("dangling profile alias refuses instead of inventing an uncreated logical boundary", async (t) => {
  const f = await historicalFixture(t),
    { symlink } = await import("node:fs/promises");
  f.config.profilePath = join(f.root, "dangling-profile");
  await symlink(join(f.config.media.mediaRoot, "absent-profile"), f.config.profilePath);
  const result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  assert.equal(result.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY");
});

test("profile metadata refusal executes zero file-content reads", async (t) => {
  const f = await historicalFixture(t),
    fs = await import("node:fs/promises"),
    { syncBuiltinESMExports } = await import("node:module");
  f.config.profilePath = join(f.root, "profile-alias");
  await fs.symlink(f.config.media.mediaRoot, f.config.profilePath);
  let calls = 0;
  t.mock.method(fs.default, "readFile", () => {
    calls++;
    throw new Error("No content reads allowed");
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await transcriptCatalogue({ config: f.config, mode: "inspect" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(result.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY");
  assert.equal(calls, 0);
});

test("destination capacity mutation is caught before immutable output and beforeimage checks retain byte budgets", async (t) => {
  const f = await fixture(t),
    options = { config: f.config, manifestPath: f.manifestPath };
  await transcriptCatalogue({ ...options, mode: "plan" });
  let changed = false;
  const denied = await transcriptCatalogue(
    { ...options, mode: "publish" },
    {
      ...f.dependencies,
      createCapacity: async () => ({
        check: async (request) => {
          if (request.bytes && !changed) {
            changed = true;
            await writeFile(f.sourcePath, f.raw + " ");
          }
        },
      }),
    },
  );
  assert.equal(denied.status, "failed");
  assert.equal(denied.evidence.written, 0);
  await writeFile(f.sourcePath, f.raw);
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  const queue = JSON.parse(await readFile(f.queuePath));
  queue.queue[0].title = "Changed title";
  await writeFile(f.queuePath, JSON.stringify(queue));
  options.manifestPath = join(f.root, "second-catalogue.json");
  await transcriptCatalogue({ ...options, mode: "plan" });
  const checks = [];
  assert.equal(
    (
      await transcriptCatalogue(
        { ...options, mode: "publish" },
        {
          ...f.dependencies,
          createCapacity: async () => ({ check: async (request) => checks.push(request) }),
        },
      )
    ).status,
    "passed",
  );
  const before = checks.find((request) => request.path?.endsWith("before.md"));
  assert.ok(before?.bytes > 0);
  assert.equal(before.boundary, f.config.courses[0].destination);
  assert.equal(before.bytes, (await readFile(before.path)).length);
});

test("explicit catalogue selection/manifest/output/receipt paths exclude logical and physical profiles before any content access", async (t) => {
  for (const kind of [
    "selection",
    "plan-existing",
    "plan-absent",
    "verify",
    "publish",
    "receipt",
    "logical",
    "dangling",
  ]) {
    const f = await historicalFixture(t),
      fs = await import("node:fs/promises"),
      { syncBuiltinESMExports } = await import("node:module");
    const profile = join(f.root, "private-profile"),
      alias = join(f.root, "profile-alias");
    await fs.mkdir(profile);
    await fs.symlink(profile, alias);
    f.config.profilePath = alias;
    const secret = join(profile, "private.json");
    await writeFile(secret, '{"private":"fixture"}');
    let manifestPath = join(f.root, "safe-manifest.json"),
      selectionPath,
      mode = "plan";
    if (kind === "selection") selectionPath = secret;
    else if (kind === "receipt") {
      mode = "verify";
      await fs.symlink(secret, manifestPath + ".catalogue-plan.json");
    } else {
      mode = ["publish", "verify"].includes(kind) ? kind : "plan";
      manifestPath =
        kind === "plan-absent"
          ? join(profile, "future.json")
          : kind === "logical"
            ? join(alias, "future.json")
            : secret;
      if (kind === "dangling") {
        manifestPath = join(f.root, "dangling-input.json");
        await fs.symlink(join(profile, "absent.json"), manifestPath);
      }
    }
    let opens = 0;
    t.mock.method(fs.default, "open", () => {
      opens++;
      throw new Error("Forbidden content access");
    });
    syncBuiltinESMExports();
    let result;
    try {
      result = await transcriptCatalogue(
        { config: f.config, mode, manifestPath, selectionPath },
        f.dependencies,
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(result.checks[0].code, "CATALOGUE_PROFILE_BOUNDARY", kind);
    assert.equal(opens, 0, kind);
    assert.equal(await readFile(secret, "utf8"), '{"private":"fixture"}');
    assert.doesNotMatch(JSON.stringify(result), /private-profile|private.json|profile-alias/);
  }
});

test("explicit paths beside a physically pinned profile remain compatible", async (t) => {
  const f = await fixture(t),
    { mkdir, symlink } = await import("node:fs/promises");
  const privateParent = join(f.root, "private-parent"),
    profile = join(privateParent, "profile");
  await mkdir(profile, { recursive: true });
  const alias = join(f.root, "profile-alias");
  await symlink(profile, alias);
  f.config.profilePath = alias;
  const selectionPath = join(privateParent, "selection.json");
  await writeFile(selectionPath, "[]");
  const options = { config: f.config, manifestPath: join(privateParent, "catalogue.json") };
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "plan", selectionPath })).status,
    "passed",
  );
  assert.equal(
    (await transcriptCatalogue({ ...options, mode: "publish" }, f.dependencies)).status,
    "passed",
  );
  assert.equal((await transcriptCatalogue({ ...options, mode: "verify" })).status, "passed");
});
