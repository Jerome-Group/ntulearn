import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
  unlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupRecoveryVad } from "../src/media/vad-setup.mjs";
import { createRuntimeCommandRunner } from "../src/media/runtime-command.mjs";
import { mediaSafetyPath } from "../src/media/safety.mjs";
import { historicalDigest } from "../src/media/historical-files.mjs";
import {
  verifyRecoveryVad,
  verifyVadCapabilities,
  assertRecoveryVadInputs,
  vadPaths,
  VAD_MODEL,
  VAD_RUNTIME,
} from "../src/media/vad.mjs";

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
  const delegatePath = join(root, "delegate-bin"),
    executionPath = join(root, "delegate-link");
  const delegateBytes = Buffer.from("synthetic delegated ASR binary");
  await writeFile(delegatePath, delegateBytes);
  await symlink(delegatePath, executionPath);
  const delegateSpec = {
    key: "asr.delegate",
    executionPath,
    canonicalPath: delegatePath,
    sha256: historicalDigest(delegateBytes),
    bytes: delegateBytes.length,
    packageVersion: "fixture",
  };
  const executable = Buffer.from(`#!/bin/sh\nset -eu\nexec ${executionPath} "$@"\n`);
  await writeFile(join(runtime.root, "bin/whisper"), executable);
  const runtimePin = {
    ...VAD_RUNTIME,
    sha256: historicalDigest(executable),
    bytes: executable.length,
  };
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
      delegateSpec,
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
  return {
    root,
    config,
    verified,
    body,
    deps,
    requests,
    delegatePath,
    executionPath,
    paths: vadPaths(runtime),
  };
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
        ? async () => {
            if (failure === "interrupt") setTimeout(() => controller.abort(), 20);
            return new Promise(() => {});
          }
        : async () => ({
            ok: true,
            body: new globalThis.ReadableStream({
              start(c) {
                c.enqueue(body);
                c.close();
              },
            }),
          });
    assert.equal(
      (
        await setupRecoveryVad(
          { config: f.config, signal: controller.signal },
          {
            ...f.deps,
            verifyRuntime: async (...args) => {
              // Preparation may outlast the former pre-call abort timer.
              if (failure === "interrupt") await new Promise((done) => setTimeout(done, 60));
              return f.deps.verifyRuntime(...args);
            },
            fetcher,
            downloadTimeoutMs: 40,
          },
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

for (const code of ["MEDIA_PROCESS_CLEANUP", "MEDIA_BROWSER_CLEANUP"])
  test(`optional setup reports typed ${code} and retains a barrier blocking the next attempt`, async (t) => {
    const f = await fixture(t);
    let downloads = 0;
    const privateMarker =
      "private fixture details /sensitive/session https://example.test/?token=secret";
    const cause = Object.assign(new Error(privateMarker), { code });
    const result = await setupRecoveryVad(
      { config: f.config },
      {
        ...f.deps,
        commandRunner: async () => {
          throw new Error(privateMarker, { cause });
        },
        fetcher: async () => {
          downloads++;
          throw new Error();
        },
      },
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0].code, code);
    assert.equal(result.evidence.failureCode, code);
    assert.equal(result.evidence.cleanupCode, code);
    assert.equal(result.evidence.cleanup, "unconfirmed");
    assert.equal(result.evidence.safetyBarrier, "retained");
    assert.match(result.checks[0].action, /do not retry setup automatically/);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|secret|example.test|fixture details/);
    assert.equal(JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code, code);
    let runtimeChecks = 0;
    const repeated = await setupRecoveryVad(
      { config: f.config },
      {
        ...f.deps,
        verifyRuntime: async () => {
          runtimeChecks++;
          return f.verified;
        },
      },
    );
    assert.equal(repeated.status, "blocked");
    assert.equal(repeated.evidence.failureCode, "MEDIA_SAFETY_BARRIER");
    assert.equal(repeated.evidence.safetyBarrier, "blocks-admission");
    assert.equal(runtimeChecks, 0);
    assert.equal(downloads, 0);
    await assert.rejects(readFile(f.paths.model), { code: "ENOENT" });
    assert.equal(
      await readFile(join(f.verified.runtime.root, "manifest.json"), "utf8"),
      "base evidence",
    );
  });

test("optional setup preserves unconfirmed cleanup subtype when the durable barrier cannot be written", async (t) => {
  const f = await fixture(t),
    occupied = join(f.root, "occupied-parent");
  await writeFile(occupied, "preserved fixture file");
  const config = { ...f.config, statePath: join(occupied, "state.json") };
  const result = await setupRecoveryVad(
    { config },
    {
      ...f.deps,
      lock: async ({ run }) => run(),
      admission: async () => {},
      commandRunner: async () => {
        throw Object.assign(new Error("private fixture secret"), {
          code: "MEDIA_PROCESS_CLEANUP",
          globalSafety: true,
        });
      },
    },
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.evidence.failureCode, "MEDIA_SAFETY_BARRIER_WRITE");
  assert.equal(result.evidence.cleanupCode, "MEDIA_PROCESS_CLEANUP");
  assert.equal(result.evidence.cleanup, "unconfirmed");
  assert.equal(result.evidence.safetyBarrier, "write-failed");
  assert.match(result.checks[0].action, /retain external containment/);
  assert.doesNotMatch(JSON.stringify(result), /private fixture|secret|occupied-parent/);
  assert.equal(await readFile(occupied, "utf8"), "preserved fixture file");
});

test("launched synthetic wrapper cannot hide mutated delegate bytes behind identical capability flags", async (t) => {
  const f = await fixture(t);
  const help = (await f.deps.commandRunner()).stdout;
  const script = Buffer.from(
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(help)});\n`,
  );
  await writeFile(f.delegatePath, script);
  await chmod(f.delegatePath, 0o700);
  await chmod(join(f.verified.runtime.root, "bin/whisper"), 0o700);
  const deps = {
    ...f.deps,
    delegateSpec: {
      ...f.deps.delegateSpec,
      sha256: historicalDigest(script),
      bytes: script.length,
    },
    commandRunner: createRuntimeCommandRunner({ commandTimeoutMs: 1000 }),
  };
  const proof = await verifyVadCapabilities(f.verified, undefined, deps);
  assert.equal(proof.delegate.input.sha256, historicalDigest(script));
  await writeFile(
    f.delegatePath,
    Buffer.concat([script, Buffer.from("// changed build with same help\n")]),
  );
  let probes = 0;
  await assert.rejects(
    verifyVadCapabilities(f.verified, undefined, {
      ...deps,
      commandRunner: async (...args) => {
        probes++;
        return deps.commandRunner(...args);
      },
    }),
  );
  assert.equal(probes, 0);
});

for (const kind of ["mutate", "retarget"])
  test(`delegate ${kind} during capabilities refuses despite unchanged help`, async (t) => {
    const f = await fixture(t),
      help = f.deps.commandRunner;
    await assert.rejects(
      verifyVadCapabilities(f.verified, undefined, {
        ...f.deps,
        commandRunner: async (...args) => {
          if (kind === "mutate")
            await writeFile(f.delegatePath, Buffer.alloc(f.deps.delegateSpec.bytes));
          else {
            const copy = join(f.root, "delegate-copy");
            await writeFile(copy, await readFile(f.delegatePath));
            await unlink(f.executionPath);
            await symlink(copy, f.executionPath);
          }
          return help(...args);
        },
      }),
    );
  });

test("prepared canonical delegate target refuses same-byte retarget during later admission and unchanged setup repeat", async (t) => {
  const f = await fixture(t);
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "passed");
  const proof = await verifyRecoveryVad({ runtime: f.verified }, f.deps);
  const beforeReceipt = await readFile(f.paths.receipt);
  const copy = join(f.root, "same-byte-delegate");
  await writeFile(copy, await readFile(f.delegatePath));
  await unlink(f.executionPath);
  await symlink(copy, f.executionPath);
  await assert.rejects(assertRecoveryVadInputs(proof), { code: "RECOVERY_VAD_UNPREPARED" });
  assert.equal((await setupRecoveryVad({ config: f.config }, f.deps)).status, "blocked");
  assert.deepEqual(await readFile(f.paths.receipt), beforeReceipt);
});

test("unknown wrapper execution target refuses before capability execution or optional writes", async (t) => {
  const f = await fixture(t),
    path = join(f.verified.runtime.root, "bin/whisper");
  const body = Buffer.from('#!/bin/sh\nexec /foreign/fixture "$@"\n');
  await writeFile(path, body);
  let probes = 0;
  const runtimePin = { ...f.deps.runtimePin, sha256: historicalDigest(body), bytes: body.length };
  f.verified.artifacts[0] = {
    ...f.verified.artifacts[0],
    sha256: runtimePin.sha256,
    bytes: runtimePin.bytes,
  };
  assert.equal(
    (
      await setupRecoveryVad(
        { config: f.config },
        {
          ...f.deps,
          runtimePin,
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
  await assert.rejects(readFile(f.paths.journal), { code: "ENOENT" });
});

test("foreign delegated resolution refuses before reading unexpected bytes or probing capabilities", async (t) => {
  const f = await fixture(t),
    foreign = join(f.root, "foreign-target");
  await writeFile(foreign, Buffer.alloc(f.deps.delegateSpec.bytes + 1));
  await unlink(f.executionPath);
  await symlink(foreign, f.executionPath);
  let probes = 0;
  await assert.rejects(
    verifyVadCapabilities(f.verified, undefined, {
      ...f.deps,
      commandRunner: async () => {
        probes++;
        return { code: 0 };
      },
    }),
    { code: "RECOVERY_VAD_UNPREPARED" },
  );
  assert.equal(probes, 0);
});
