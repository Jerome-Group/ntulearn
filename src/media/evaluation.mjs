import { withEvaluationRead } from "./evaluation-read.mjs";
import { evaluationOutputRoot } from "./evaluation-storage.mjs";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import { evaluateFixture } from "./evaluation-fixture.mjs";
import { mkdir, readdir, lstat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import { readEvaluationManifest, assertEvaluationInputsUnchanged } from "./evaluation-manifest.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";
import { runMediaProcess } from "./process.mjs";

const ACTION =
  "Inspect the retained private evidence, correct inputs or restore runtime/storage, then retry with a new output directory.";

export async function planMediaEvaluation({ manifestPath }) {
  try {
    const manifest = await readEvaluationManifest(manifestPath);
    return capabilityResult(
      "media:evaluate:plan",
      [
        observation(
          "manifest",
          "passed",
          "EVALUATION_PLANNED",
          "Input hashes, declared provenance and bounded budgets validated.",
        ),
      ],
      {
        fixtures: manifest.fixtures.map(({ id, audio, reference }) => ({
          id,
          sourceSha256: audio.sha256,
          referenceKind: reference.kind,
        })),
        budgets: manifest.budgets,
        execution: "unrun",
        acousticQuality: "unrun",
      },
    );
  } catch (error) {
    return capabilityResult("media:evaluate:plan", [
      {
        ...failure("manifest", error),
        message: "Evaluation plan could not be validated; no evaluation output was created.",
        action:
          "Check the private manifest, input hashes, provenance and budgets, then retry plan.",
      },
    ]);
  }
}

export async function runMediaEvaluation(
  {
    manifestPath,
    outputDirectory,
    outputRoot,
    media,
    signalProcessGroup,
    memoryMeasurement = null,
    codeRevision = null,
    signal,
  },
  dependencies = {},
) {
  const checks = [];
  const started = performance.now();
  const evidence = {
    fixtures: [],
    stages: [],
    codeRevision: /^[0-9a-f]{40}$/.test(codeRevision ?? "") ? codeRevision : null,
    acousticGroundTruth: "unrun",
    physicalIoCancellation: "unclaimed",
    processOwnership: "original-posix-process-group",
  };
  let manifest;
  let output;
  let capacity;
  let timer;
  let deadline = null;
  const readOptions = () => ({
    signal: combined,
    timeoutMs: Math.max(
      1,
      Math.min(5000, deadline ? Math.floor(deadline - performance.now()) : 5000),
    ),
  });
  let put;
  let ownsOutput = false;
  const preflightProcesses = new Set();
  const preflightFailures = [];
  const controller = new globalThis.AbortController();
  const combined = signal
    ? globalThis.AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    manifest = await readEvaluationManifest(manifestPath, { signal: combined });
    evidence.budgets = manifest.budgets;
    deadline = performance.now() + manifest.budgets.jobTimeoutMs;
    timer = setTimeout(
      () => controller.abort(coded("EVALUATION_JOB_TIMEOUT")),
      manifest.budgets.jobTimeoutMs,
    );
    const runtime = await withEvaluationRead(
      (probeSignal) =>
        (dependencies.verifyRuntime ?? verifyMediaRuntime)(media, {
          commandRunner: async (command, args) => {
            const pending = runMediaProcess(command, args, {
              signal: probeSignal,
              signalProcessGroup,
              timeoutMs: manifest.budgets.processTimeoutMs,
              label: "Evaluation runtime verification",
              stdoutMaxBytes: 64 * 1024,
              stderrMaxBytes: 64 * 1024,
            });
            preflightProcesses.add(pending);
            try {
              await pending;
            } catch (error) {
              preflightFailures.push(error);
              throw error;
            } finally {
              preflightProcesses.delete(pending);
            }
            return { code: 0 };
          },
        }),
      readOptions(),
    );
    combined.throwIfAborted();
    checks.push(
      observation(
        "runtime",
        "passed",
        "EVALUATION_RUNTIME_VERIFIED",
        "Mandatory runtime artifact hashes and tools verified.",
      ),
    );
    const pinKeys = new Set([
      "mediaTool",
      "asr.runtime",
      "asr.model",
      "formatter.runtime",
      "formatter.model",
    ]);
    evidence.runtimePins = runtime.artifacts
      .filter(({ key, sha256 }) => pinKeys.has(key) && /^[0-9a-f]{64}$/.test(sha256))
      .map(({ key, sha256, revision }) => ({
        key,
        sha256,
        ...(/^(?:[0-9a-f]{40}|v?\d+(?:\.\d+){1,3})$/.test(revision ?? "") ? { revision } : {}),
      }));
    const boundary = await withEvaluationRead(
      () =>
        evaluationOutputRoot(media, outputRoot, {
          ...(dependencies.volumeRoot ? { volumeRoot: dependencies.volumeRoot } : {}),
        }),
      readOptions(),
    );
    capacity = await withEvaluationRead(
      () =>
        (dependencies.createCapacity ?? defaultCapacity)(media, {
          courses: [{ destination: boundary }],
        }),
      readOptions(),
    );
    combined.throwIfAborted();
    output = resolve(outputDirectory);
    const relation = relative(boundary, output);
    if (
      !relation ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      relation.startsWith(sep)
    )
      throw coded("EVALUATION_OUTPUT_INVALID");
    await withEvaluationRead(
      () => (dependencies.assertArtifactPath ?? assertMediaArtifactPath)(output, boundary),
      readOptions(),
    );
    await withEvaluationRead(
      () => capacity.check({ path: output, boundary, bytes: manifest.budgets.maxOutputBytes }),
      readOptions(),
    );
    combined.throwIfAborted();
    await mkdir(output, { mode: 0o700 }); // Exclusive directory: previous attempts and user edits are never reused.
    ownsOutput = true;
    await mkdir(join(output, "work"), { mode: 0o700 });
    put = async (name, data) => {
      const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      await budgetCheck(Buffer.byteLength(body));
      combined.throwIfAborted();
      await writeFile(join(output, name), body, { flag: "wx", mode: 0o600 });
    };
    const budgetCheck = async (bytes = 0) => {
      const actual = await withEvaluationRead(() => directoryBytes(output), readOptions());
      evidence.observedPeakArtifactBytes = Math.max(
        evidence.observedPeakArtifactBytes ?? 0,
        actual,
      );
      if (actual + bytes > manifest.budgets.maxOutputBytes) throw coded("EVALUATION_OUTPUT_BUDGET");
      await withEvaluationRead(
        () => capacity.check({ path: output, boundary, bytes }),
        readOptions(),
      );
    };
    await put("provenance.json", {
      version: manifest.version,
      budgets: manifest.budgets,
      fixtures: manifest.fixtures.map(({ id, audio, reference }) => ({
        id,
        sourceSha256: audio.sha256,
        referenceKind: reference.kind,
        referenceSha256: reference.sha256 ?? null,
        provenance: reference.provenance ?? null,
      })),
    });
    let pending = null;
    const monitor = setInterval(() => {
      if (!pending)
        pending = budgetCheck()
          .catch((error) => controller.abort(error))
          .finally(() => {
            pending = null;
          });
    }, 1000);
    try {
      for (const fixture of manifest.fixtures) {
        combined.throwIfAborted();
        await budgetCheck();
        await evaluateFixture({
          fixture,
          manifest,
          media,
          runtime,
          output,
          put,
          budgetCheck,
          combined,
          memoryMeasurement,
          signalProcessGroup,
          evidence,
          checks,
          dependencies,
        });
      }
    } finally {
      clearInterval(monitor);
      await pending;
    }
    combined.throwIfAborted();
    evidence.artifactBytesBeforeReport = await withEvaluationRead(
      () => directoryBytes(output),
      readOptions(),
    );
  } catch (error) {
    checks.push(
      failure(
        "execution",
        error?.globalSafety ? error : controller.signal.aborted ? controller.signal.reason : error,
      ),
    );
  } finally {
    await Promise.allSettled([...preflightProcesses]);
    const cleanup = preflightFailures.find((error) => error?.globalSafety);
    if (cleanup) {
      const existing = checks.findIndex(({ id }) => id === "execution");
      if (existing >= 0) checks[existing] = failure("execution", cleanup);
      else checks.push(failure("execution", cleanup));
    }
    if (manifest) {
      try {
        await assertEvaluationInputsUnchanged(manifest, readOptions());
        checks.push(
          observation(
            "inputs",
            "passed",
            "EVALUATION_INPUTS_PRESERVED",
            "Source and reference hashes unchanged after execution.",
          ),
        );
      } catch (error) {
        checks.push(failure("inputs", error));
      }
    }
    if (ownsOutput && put) {
      evidence.wallMsBeforeReport = Math.round(performance.now() - started);
      try {
        await put("evaluation.json", { schemaVersion: 1, checks, evidence });
      } catch (error) {
        checks.push(failure("evidence-storage", error));
      }
    }
    if (controller.signal.aborted && !checks.some(({ id }) => id === "execution"))
      checks.push(failure("execution", controller.signal.reason));
    clearTimeout(timer);
  }
  return capabilityResult("media:evaluate:run", checks, evidence);
}

async function defaultCapacity(media, options) {
  const { createMediaCapacity } = await import("./capacity.mjs");
  return createMediaCapacity(media, options);
}
async function directoryBytes(path) {
  let bytes = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw coded("EVALUATION_OUTPUT_INVALID");
    bytes += info.isDirectory() ? await directoryBytes(child) : info.size;
  }
  return bytes;
}
function coded(code) {
  const error = new Error(ACTION);
  error.code = code;
  return error;
}
function failure(id, error) {
  const code =
    /^EVALUATION_[A-Z_]+$/.test(error?.code ?? "") || /^MEDIA_[A-Z_]+$/.test(error?.code ?? "")
      ? error?.code
      : "EVALUATION_FAILED";
  return observation(
    id,
    "failed",
    code,
    "Evaluation did not complete safely; retained private evidence may contain the rejected stage.",
    ACTION,
  );
}
