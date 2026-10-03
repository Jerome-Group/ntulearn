import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";
import {
  unassociatedTranscripts,
  UNASSOCIATED_CONFIRMATION,
} from "../src/media/unassociated-format.mjs";

async function fixture(t, text = "Let x = 2 + 3; uncertain [inaudible] remains.") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "unassociated-format-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  const sourcePath = join(mediaRoot, "recordings", "opaque", "transcript.raw.json");
  await mkdir(join(mediaRoot, "recordings", "opaque"), { recursive: true });
  const source = JSON.stringify({ language: "en", segments: [{ start: 0, end: 5, text }] });
  await writeFile(sourcePath, source);
  const config = {
    courses: [],
    statePath: join(root, "state.json"),
    profilePath: join(root, "profile"),
    media: { mediaRoot },
  };
  const manifestPath = join(root, "plan.json");
  const dependencies = { createCapacity: async () => ({ check: async () => {} }) };
  const invoke = (mode) =>
    unassociatedTranscripts(
      { mode, manifestPath, config, confirmation: UNASSOCIATED_CONFIRMATION },
      dependencies,
    );
  return { root, mediaRoot, sourcePath, source, config, manifestPath, dependencies, invoke };
}

test("unassociated mathematics publishes immutable review reading and repeats without writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke("plan")).status, "passed");
  const plan = JSON.parse(await readFile(f.manifestPath));
  assert.equal(plan.sources.length, 1);
  const applied = await f.invoke("apply");
  assert.equal(applied.status, "passed");
  const path = join(f.mediaRoot, "Unassociated", "Review", plan.id, plan.sources[0].id + ".md");
  const markdown = await readFile(path, "utf8");
  assert.match(markdown, /Let x = 2 \+ 3; uncertain \[inaudible\] remains\./);
  assert.match(markdown, /Association: unproven/);
  assert.match(markdown, /Review only/);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.source);
  assert.equal((await f.invoke("apply")).evidence.written, 0);
  assert.equal((await f.invoke("verify")).status, "passed");
});

test("repetition remains verbatim review evidence and never becomes complete", async (t) => {
  const text = "we we we we we we we we we explain x = 2";
  const f = await fixture(t, text);
  assert.equal((await f.invoke("plan")).status, "passed");
  const plan = JSON.parse(await readFile(f.manifestPath));
  assert.deepEqual(plan.sources[0].sourceFlags, ["suspicious-repetition"]);
  const result = await f.invoke("apply");
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.complete, false);
  const path = join(f.mediaRoot, "Unassociated", "Review", plan.id, plan.sources[0].id + ".md");
  assert.match(await readFile(path, "utf8"), /we we we we we we we we we explain x = 2/);
});

test("empty source is accounted but no reading is published; metadata-present source excluded", async (t) => {
  const f = await fixture(t, "");
  const other = join(f.mediaRoot, "recordings", "other");
  await mkdir(other);
  await writeFile(join(other, "transcript.raw.json"), f.source);
  await writeFile(join(other, "transcript.metadata.json"), "private metadata deliberately unread");
  const result = await f.invoke("plan");
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.eligible, 0);
  assert.equal(result.evidence.invalid, 1);
  assert.equal(result.evidence.metadataPresentExcluded, 1);
});

test("overwritten unsafe raw tokens refuse without publishing a plan", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.sourcePath,
    '{"discarded":"https://private.invalid/?token=secret","discarded":"safe","segments":[{"start":0,"end":1,"text":"valid speech"}]}',
  );
  const result = await f.invoke("plan");
  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|secret/);
  await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
});

test("source mutation, new metadata and edited occupied outputs refuse without replacement", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke("plan")).status, "passed");
  await writeFile(f.sourcePath, f.source.replace("2 + 3", "2 + 4"));
  assert.equal((await f.invoke("apply")).status, "failed");
  await writeFile(f.sourcePath, f.source);
  await rm(f.manifestPath);
  assert.equal((await f.invoke("plan")).status, "passed");
  const plan = JSON.parse(await readFile(f.manifestPath));
  const path = join(f.mediaRoot, "Unassociated", "Review", plan.id, plan.sources[0].id + ".md");
  await mkdir(join(f.mediaRoot, "Unassociated", "Review", plan.id), { recursive: true });
  await writeFile(path, "Owner annotation retained");
  assert.equal((await f.invoke("apply")).status, "failed");
  assert.equal(await readFile(path, "utf8"), "Owner annotation retained");
  await writeFile(join(f.mediaRoot, "recordings", "opaque", "transcript.metadata.json"), "{}");
  assert.equal((await f.invoke("verify")).status, "failed");
});

test("mutation between publications stops before further output", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke("plan")).status, "passed");
  const result = await unassociatedTranscripts(
    {
      mode: "apply",
      manifestPath: f.manifestPath,
      config: f.config,
      confirmation: UNASSOCIATED_CONFIRMATION,
    },
    {
      ...f.dependencies,
      afterOutput: async ({ written }) => {
        if (written === 1) await writeFile(f.sourcePath, f.source.replace("2 + 3", "9 + 3"));
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.written, 1);
});

test("apply requires the exact explicit confirmation", async (t) => {
  const f = await fixture(t);
  const result = await unassociatedTranscripts(
    { mode: "apply", config: f.config, manifestPath: f.manifestPath },
    f.dependencies,
  );
  assert.equal(result.checks[0].code, "UNASSOCIATED_FORMAT_USAGE");
  await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
});

test("unconfirmed source descriptor closure retains barrier and refuses restart", async (t) => {
  const f = await fixture(t);
  const { open } = await import("node:fs/promises");
  const { mediaSafetyPath } = await import("../src/media/safety.mjs");
  let release, entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const task = unassociatedTranscripts(
    { mode: "plan", manifestPath: f.manifestPath, config: f.config },
    {
      files: {
        limits: { fileTimeoutMs: 20, cleanupTimeoutMs: 20 },
        openFile: async (...args) => {
          const handle = await open(...args);
          if (args[0] !== f.sourcePath) return handle;
          return {
            stat: (...a) => handle.stat(...a),
            read: (...a) => handle.read(...a),
            close: async () => {
              entered();
              await pending;
              await handle.close();
            },
          };
        },
      },
    },
  );
  await started;
  const result = await task;
  assert.equal(result.checks[0].code, "MEDIA_FILE_CLEANUP");
  assert.equal(result.evidence.containmentRequired, true);
  assert.equal(result.evidence.barrierPersistence, "passed");
  assert.equal(
    JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
    "MEDIA_FILE_CLEANUP",
  );
  assert.equal((await f.invoke("plan")).checks[0].code, "MEDIA_SAFETY_BARRIER");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
});

test("raw leaf aliases and profile-alias media roots refuse before source content", async (t) => {
  const f = await fixture(t);
  const { symlink, rename } = await import("node:fs/promises");
  await rename(f.sourcePath, f.sourcePath + ".retained");
  await symlink(f.sourcePath + ".retained", f.sourcePath);
  assert.equal((await f.invoke("plan")).status, "failed");
  await rm(f.sourcePath);
  await rename(f.sourcePath + ".retained", f.sourcePath);
  await symlink(f.mediaRoot, f.config.profilePath);
  let reads = 0;
  const result = await unassociatedTranscripts(
    { mode: "plan", manifestPath: f.manifestPath, config: f.config },
    {
      files: {
        openFile: async () => {
          reads++;
          throw Error("must not open profile");
        },
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(reads, 0);
});

for (const barrierWritable of [true, false]) {
  test(`durable reading close failure ${barrierWritable ? "stores barrier" : "retains armed lock when barrier storage fails"}`, async (t) => {
    const f = await fixture(t);
    const { chmod } = await import("node:fs/promises");
    assert.equal((await f.invoke("plan")).status, "passed");
    let closed = false;
    let result;
    try {
      result = await unassociatedTranscripts(
        {
          mode: "apply",
          manifestPath: f.manifestPath,
          config: f.config,
          confirmation: UNASSOCIATED_CONFIRMATION,
        },
        {
          ...f.dependencies,
          files: {
            closePublishedHandle: async (handle) => {
              await handle.close();
              closed = true;
              if (!barrierWritable) await chmod(f.root, 0o500);
              throw Object.assign(Error("private close details token=secret"), {
                code: "MEDIA_FILE_CLEANUP",
                globalSafety: true,
              });
            },
          },
        },
      );
    } finally {
      await chmod(f.root, 0o700);
    }
    assert.equal(closed, true);
    assert.equal(result.status, "failed");
    assert.equal(
      result.checks[0].code,
      barrierWritable ? "MEDIA_FILE_CLEANUP" : "MEDIA_SAFETY_BARRIER_WRITE",
    );
    assert.equal(result.evidence.containmentRequired, true);
    assert.equal(result.evidence.cleanupCode, "MEDIA_FILE_CLEANUP");
    assert.doesNotMatch(JSON.stringify(result), /private close|secret/);
    if (!barrierWritable)
      assert.equal(
        await readFile(join(f.root, "media-queue.lock", "safety-armed"), "utf8"),
        "v1\n",
      );
    assert.equal((await f.invoke("apply")).status, "failed");
    assert.equal(await readFile(f.sourcePath, "utf8"), f.source);
  });
}

test("profile-bound state path is refused before any apply lock", async (t) => {
  const f = await fixture(t);
  await mkdir(f.config.profilePath);
  const config = { ...f.config, statePath: join(f.config.profilePath, "state.json") };
  const result = await unassociatedTranscripts(
    {
      mode: "apply",
      manifestPath: f.manifestPath,
      config,
      confirmation: UNASSOCIATED_CONFIRMATION,
    },
    f.dependencies,
  );
  assert.equal(result.status, "failed");
  await assert.rejects(readFile(join(f.config.profilePath, "media-queue.lock", "owner.json")), {
    code: "ENOENT",
  });
});

test("same-byte replacement and parent alias retarget after plan refuse", async (t) => {
  const f = await fixture(t);
  const { rename, symlink } = await import("node:fs/promises");
  assert.equal((await f.invoke("plan")).status, "passed");
  await rename(f.sourcePath, f.sourcePath + ".retained");
  await writeFile(f.sourcePath, f.source);
  assert.equal((await f.invoke("apply")).status, "failed");
  await rm(f.manifestPath);
  assert.equal((await f.invoke("plan")).status, "passed");
  const parent = join(f.mediaRoot, "recordings", "opaque");
  await rename(parent, parent + "-retained");
  await symlink(parent + "-retained", parent);
  assert.equal((await f.invoke("apply")).status, "failed");
});

test("actual CLI invalid confirmation and missing owned config emit private-safe structured exit2", async (t) => {
  const f = await fixture(t);
  const { spawnSync } = await import("node:child_process");
  const cli = new URL("../src/cli.mjs", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  for (const args of [
    ["apply", f.manifestPath],
    ["plan", f.manifestPath],
  ]) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(cli), "media-format-unassociated", ...args],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, NTULEARN_CONFIG_PATH: join(f.root, "absent-config.json") },
      },
    );
    assert.equal(child.status, 2);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, "blocked");
    assert.equal(child.stderr, "");
    assert.doesNotMatch(child.stdout, /absent-config|unassociated-format-/);
  }
});

test("unchanged apply performs zero publication mkdir, staging opens or byte writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke("plan")).status, "passed");
  assert.equal((await f.invoke("apply")).status, "passed");
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const originalOpen = fs.promises.open,
    originalMkdir = fs.promises.mkdir;
  let stagingOpens = 0,
    writes = 0,
    directories = 0;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes(".part-")) {
      stagingOpens++;
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (...a) => {
        writes++;
        return originalWrite(...a);
      };
    }
    return handle;
  };
  fs.promises.mkdir = async (...args) => {
    if (String(args[0]).startsWith(join(f.mediaRoot, "Unassociated"))) directories++;
    return originalMkdir(...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await f.invoke("apply");
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
  }
  assert.equal(result.status, "passed");
  assert.equal(result.evidence.written, 0);
  assert.equal(stagingOpens, 0);
  assert.equal(writes, 0);
  assert.equal(directories, 0);
});

test("ordinary plans refuse dedicated state controls before creating any admission file", async (t) => {
  const f = await fixture(t);
  const stateParent = join(f.root, ".data");
  await mkdir(stateParent);
  const config = { ...f.config, statePath: join(stateParent, "state.json") };
  const { mediaSafetyPath } = await import("../src/media/safety.mjs");
  for (const name of [
    "media-safety.json",
    "media-queue/fixture.json",
    "media-queue.lock/plan.json",
    "media-lock-admission.json",
    "watchdog.lock",
    "runs/plan.json",
    "digests/plan.json",
    "otherwise-private.json",
  ]) {
    const manifestPath = join(stateParent, name);
    const result = await unassociatedTranscripts(
      { mode: "plan", manifestPath, config },
      f.dependencies,
    );
    assert.equal(result.status, "failed");
    await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  }
  await assert.rejects(readFile(mediaSafetyPath(config.statePath)), { code: "ENOENT" });
  assert.equal(
    (
      await unassociatedTranscripts(
        { mode: "plan", manifestPath: f.manifestPath, config },
        f.dependencies,
      )
    ).status,
    "passed",
  );
});

test("flat state-parent safety and queue controls refuse while safe private sibling works", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "media-safety.json",
    "media-queue/queue.json",
    "media-queue.lock/plan.json",
    "watchdog.lock",
    "media-latest.json",
    "logs/plan.json",
    "media-logs/plan.json",
  ]) {
    const path = join(f.root, name);
    const result = await unassociatedTranscripts(
      { mode: "plan", manifestPath: path, config: f.config },
      f.dependencies,
    );
    assert.equal(result.status, "failed");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  assert.equal((await f.invoke("plan")).status, "passed");
});

test("physical alias into dedicated state namespace refuses before any content read", async (t) => {
  const f = await fixture(t);
  const { symlink, open } = await import("node:fs/promises");
  const state = join(f.root, ".data");
  await mkdir(state);
  await writeFile(join(state, "private-input.json"), "{}");
  const alias = join(f.root, "state-alias");
  await symlink(state, alias);
  let opens = 0;
  const result = await unassociatedTranscripts(
    {
      mode: "verify",
      manifestPath: join(alias, "private-input.json"),
      config: { ...f.config, statePath: join(state, "state.json") },
    },
    {
      files: {
        openFile: async (...args) => {
          opens++;
          return open(...args);
        },
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(opens, 0);
});

test("existing-file reuse rechecks source proof after reading existing edition", async (t) => {
  const f = await fixture(t);
  const { open, stat } = await import("node:fs/promises");
  assert.equal((await f.invoke("plan")).status, "passed");
  assert.equal((await f.invoke("apply")).status, "passed");
  const plan = JSON.parse(await readFile(f.manifestPath));
  const edition = join(f.mediaRoot, "Unassociated", "Review", plan.id, plan.sources[0].id + ".md");
  const before = await stat(edition),
    original = await readFile(edition);
  let changed = false;
  const result = await unassociatedTranscripts(
    {
      mode: "apply",
      manifestPath: f.manifestPath,
      config: f.config,
      confirmation: UNASSOCIATED_CONFIRMATION,
    },
    {
      ...f.dependencies,
      files: {
        openFile: async (...args) => {
          const handle = await open(...args);
          if (args[0] !== edition) return handle;
          return {
            stat: (...a) => handle.stat(...a),
            read: (...a) => handle.read(...a),
            close: async () => {
              await handle.close();
              if (!changed) {
                changed = true;
                await writeFile(f.sourcePath, f.source.replace("2 + 3", "7 + 3"));
              }
            },
          };
        },
      },
    },
  );
  assert.equal(changed, true);
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.written, 0);
  assert.deepEqual(await readFile(edition), original);
  assert.equal((await stat(edition)).ino, before.ino);
});
