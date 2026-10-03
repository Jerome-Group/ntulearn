import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupRecoveryVad } from "../src/media/vad-setup.mjs";
import { historicalDigest } from "../src/media/historical-files.mjs";
import { verifyRecoveryVad, vadPaths, VAD_MODEL, VAD_RUNTIME } from "../src/media/vad.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-vad-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  const runtime = {
    root: join(mediaRoot, ".runtime"),
    models: join(mediaRoot, ".runtime/models"),
    metadata: join(mediaRoot, ".runtime/metadata"),
    bin: join(mediaRoot, ".runtime/bin"),
  };
  for (const key of ["models", "metadata", "bin"]) await mkdir(runtime[key], { recursive: true });
  await writeFile(join(runtime.root, "manifest.json"), "base evidence");
  const body = Buffer.from("synthetic vad model"),
    spec = { ...VAD_MODEL, sha256: historicalDigest(body), bytes: body.length };
  const executable = Buffer.from("synthetic ASR executable");
  await writeFile(join(runtime.root, "bin/whisper"), executable);
  const runtimePin = { ...VAD_RUNTIME, sha256: historicalDigest(executable) };
  const verified = {
    runtime,
    artifacts: [
      {
        key: "asr.runtime",
        sha256: runtimePin.sha256,
        bytes: executable.length,
        revision: VAD_RUNTIME.revision,
        path: "bin/whisper",
      },
    ],
  };
  const config = {
    statePath: join(root, "state.json"),
    courses: [],
    media: {
      mediaRoot,
      freeSpaceReserveBytes: 1,
      setup: { asr: { runtime: { filename: "whisper" } } },
    },
  };
  const requests = [],
    deps = {
      spec,
      runtimePin,
      verifyRuntime: async () => verified,
      volumeRoot: root,
      createCapacity: async () => ({ check: async (r) => requests.push(r) }),
      commandRunner: async () => ({
        code: 0,
        stdout:
          "--vad --vad-model --vad-threshold --vad-min-speech-duration-ms --vad-min-silence-duration-ms --vad-max-speech-duration-s --vad-speech-pad-ms --vad-samples-overlap --processors --suppress-nst",
      }),
      fetcher: async () => ({
        ok: true,
        body: new globalThis.ReadableStream({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        }),
      }),
    };
  return { root, config, verified, body, deps, requests, paths: vadPaths(runtime) };
}

test("explicit optional setup keeps base evidence, repeats matching proof, refuses unknown occupied bytes", async (t) => {
  const f = await fixture(t);
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "passed");
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).evidence.existing, true);
  assert.equal(
    await readFile(join(f.verified.runtime.root, "manifest.json"), "utf8"),
    "base evidence",
  );
  assert.ok(f.requests.some((r) => r.bytes === f.body.length));
  await writeFile(f.paths.model, "foreign edit");
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "blocked");
  assert.equal(await readFile(f.paths.model, "utf8"), "foreign edit");
});
test("prepared model and exact runtime capabilities required; interrupted setup resumes unchanged proof", async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyRecoveryVad({ runtime: f.verified }, f.deps));
  let stopped = false;
  const interrupted = await setupRecoveryVad(
    { config: f.config },
    {
      ...f.deps,
      afterOutput: async () => {
        if (!stopped) {
          stopped = true;
          throw new Error("fixture interrupt");
        }
      },
    },
  );
  assert.equal(interrupted.status, "blocked");
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "passed");
  const proof = await verifyRecoveryVad({ runtime: f.verified }, f.deps);
  assert.equal(proof.pin.sha256, f.deps.spec.sha256);
  await assert.rejects(
    verifyRecoveryVad(
      { runtime: f.verified },
      { ...f.deps, commandRunner: async () => ({ code: 0, stdout: "--vad" }) },
    ),
  );
  await writeFile(f.paths.receipt, "foreign receipt");
  await assert.rejects(verifyRecoveryVad({ runtime: f.verified }, f.deps));
});

for (const occupied of ["model", "receipt", "journal"])
  test(`foreign optional ${occupied} refuses before download and retains bytes`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths[occupied], "foreign bytes");
    let downloads = 0;
    assert.equal(
      (
        await setupRecoveryVad(
          { config: f.config },
          {
            ...f.deps,
            fetcher: async () => {
              downloads++;
              throw new Error();
            },
          },
        )
      ).status,
      "blocked",
    );
    assert.equal(downloads, 0);
    assert.equal(await readFile(f.paths[occupied], "utf8"), "foreign bytes");
  });

for (const refusal of ["runtime", "capability", "reserve", "admission", "lock"])
  test(`optional setup ${refusal} refusal neither downloads nor alters base evidence`, async (t) => {
    const f = await fixture(t);
    let downloads = 0;
    const deps = {
      ...f.deps,
      fetcher: async () => {
        downloads++;
        throw new Error();
      },
    };
    if (refusal === "runtime")
      deps.verifyRuntime = async () => ({
        ...f.verified,
        artifacts: [{ ...f.verified.artifacts[0], sha256: "0".repeat(64) }],
      });
    if (refusal === "capability")
      deps.commandRunner = async () => ({ code: 0, stdout: "--vad --vad-model" });
    if (refusal === "reserve")
      deps.createCapacity = async () => ({
        check: async () => {
          throw new Error("reserve fixture");
        },
      });
    if (refusal === "admission")
      deps.admission = async () => {
        throw new Error("safety fixture");
      };
    if (refusal === "lock")
      deps.lock = async () => {
        throw new Error("held fixture");
      };
    assert.equal((await setupRecoveryVad({ config: f.config }, deps)).status, "blocked");
    assert.equal(downloads, 0);
    assert.equal(
      await readFile(join(f.verified.runtime.root, "manifest.json"), "utf8"),
      "base evidence",
    );
    await assert.rejects(readFile(f.paths.model), { code: "ENOENT" });
  });

test("download wrong hash, oversized response, deadline and interruption preserve resumable intent without prepared receipt", async (t) => {
  for (const failure of ["hash", "size", "deadline", "interrupt"]) {
    const f = await fixture(t),
      controller = new globalThis.AbortController();
    const body = failure === "size" ? Buffer.alloc(f.body.length + 1) : Buffer.alloc(f.body.length);
    const fetcher =
      failure === "deadline" || failure === "interrupt"
        ? async () => new Promise(() => {})
        : async () => ({
            ok: true,
            body: new globalThis.ReadableStream({
              start(c) {
                c.enqueue(body);
                c.close();
              },
            }),
          });
    if (failure === "interrupt") setTimeout(() => controller.abort(), 20);
    assert.equal(
      (
        await setupRecoveryVad(
          { config: f.config, signal: controller.signal },
          { ...f.deps, fetcher, downloadTimeoutMs: 40 },
        )
      ).status,
      "blocked",
    );
    await assert.rejects(readFile(f.paths.model), { code: "ENOENT" });
    await assert.rejects(readFile(f.paths.receipt), { code: "ENOENT" });
    assert.ok((await readFile(f.paths.journal)).length);
    assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "passed");
  }
});

test("changed setup intent during download refuses model/receipt publication and preserves changed bytes", async (t) => {
  const f = await fixture(t);
  const fetcher = f.deps.fetcher;
  assert.equal(
    (
      await setupRecoveryVad(
        { config: f.config },
        {
          ...f.deps,
          fetcher: async (...args) => {
            await writeFile(f.paths.journal, "changed fixture intent");
            return fetcher(...args);
          },
        },
      )
    ).status,
    "blocked",
  );
  assert.equal(await readFile(f.paths.journal, "utf8"), "changed fixture intent");
  await assert.rejects(readFile(f.paths.model), { code: "ENOENT" });
  await assert.rejects(readFile(f.paths.receipt), { code: "ENOENT" });
});

test("changed executable refuses before optional capability execution", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.verified.runtime.root, "bin/whisper"), "changed executable");
  let probes = 0;
  assert.equal(
    (
      await setupRecoveryVad(
        { config: f.config },
        {
          ...f.deps,
          commandRunner: async () => {
            probes++;
            return { code: 0 };
          },
        },
      )
    ).status,
    "blocked",
  );
  assert.equal(probes, 0);
});
