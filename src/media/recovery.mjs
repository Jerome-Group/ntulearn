import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import { readRecoveryManifest, assertRecoveryInputs } from "./recovery-manifest.mjs";
import { recoveryFile, recoveryDirectoryBytes, recoveryFailure } from "./recovery-files.mjs";
import { createRecoveryCandidate } from "./recovery-candidate.mjs";
import { publishRecoveryCandidates } from "./recovery-publication.mjs";
import { readMediaQueue } from "./queue.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { evaluationOutputRoot } from "./evaluation-storage.mjs";
import { runMediaProcess } from "./process.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";
import { isGlobalMediaSafetyFailure } from "./errors.mjs";
import { VAD_RECOVERY_POLICY } from "./recovery-policy.mjs";
import { verifyRecoveryVad, assertRecoveryVadInputs } from "./vad.mjs";

const ACTION =
  "Inspect retained private candidates and ownership/safety evidence, then retry plan with unchanged inputs; publication never replaces originals.";

export async function recoverTranscriptSources(
  { mode, manifestPath, outputDirectory, config, signalProcessGroup, signal },
  dependencies = {},
) {
  const checks = [],
    evidence = {
      acousticVerification: "unrun",
      mediaReadiness: "unclaimed",
      sourceCorrection: "none",
      physicalIoCancellation: "unclaimed",
      concurrency: 1,
    };
  try {
    if (
      !["plan", "run", "publish"].includes(mode) ||
      !manifestPath ||
      (mode !== "plan" && !outputDirectory) ||
      (mode === "plan" && outputDirectory)
    )
      throw recoveryFailure("RECOVERY_ARGUMENTS");
    const admission = () =>
      (dependencies.admission ?? assertMediaSafetyAdmission)({
        statePath: config.statePath,
        courses: config.courses,
        readQueue: dependencies.readQueue ?? readMediaQueue,
      });
    await admission();
    const manifest = await readRecoveryManifest({ manifestPath, config, signal });
    evidence.policy = manifest.policy;
    evidence.recordings = manifest.recordings.length;
    evidence.sourceReviewFlags = manifest.recordings.filter(
      (recording) => recording.sourceFlags.length,
    ).length;
    if (mode === "plan") {
      checks.push(
        observation(
          "plan",
          "passed",
          "RECOVERY_PLANNED",
          "Current private source/media hashes and positive ownership validated; execution is unrun.",
        ),
      );
      evidence.execution = "unrun";
    } else {
      await (dependencies.lock ?? withMediaQueueLock)({
        statePath: config.statePath,
        run: async () => {
          try {
            await admission();
            await assertRecoveryInputs(manifest, signal);
            if (mode === "run")
              Object.assign(
                evidence,
                await runCandidates(
                  { manifest, outputDirectory, config, signalProcessGroup, signal, checks },
                  dependencies,
                ),
              );
            else {
              Object.assign(
                evidence,
                await publishRecoveryCandidates(
                  { manifest, outputDirectory, config, signalProcessGroup, signal },
                  dependencies,
                ),
              );
              if (evidence.review)
                checks.push(
                  observation(
                    "publication-review",
                    "blocked",
                    "RECOVERY_CANDIDATES_REMAIN_REVIEW",
                    evidence.publishedCandidates
                      ? "Eligible candidate editions published; flagged candidates remain unpublished for review."
                      : "No candidate qualifies for publication; retained candidates remain unpublished for review.",
                    ACTION,
                    { publishedCandidates: evidence.publishedCandidates, review: evidence.review },
                  ),
                );
            }
            await assertRecoveryInputs(manifest, signal);
            checks.push(
              observation(
                "preservation",
                "passed",
                "RECOVERY_ORIGINALS_PRESERVED",
                "Original sources, media, derivatives and ownership evidence retain their hashes.",
              ),
            );
          } catch (error) {
            await persistMediaSafetyBarrier({ statePath: config.statePath, error });
            throw error;
          }
        },
      });
    }
  } catch (error) {
    if (error?.recoveryEvidence) Object.assign(evidence, error.recoveryEvidence);
    checks.push(failure(error));
  }
  return capabilityResult(`media:recover:${mode}`, checks, evidence);
}

async function runCandidates(
  { manifest, outputDirectory, config, signalProcessGroup, signal, checks },
  dependencies,
) {
  const controller = new globalThis.AbortController();
  const combined = signal
    ? globalThis.AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(recoveryFailure("RECOVERY_JOB_TIMEOUT")),
    manifest.budgets.jobTimeoutMs,
  );
  let monitor,
    pending,
    put,
    failureError,
    ownsOutput = false;
  const candidates = [],
    stages = [];
  const output = resolve(outputDirectory);
  const report = {
    schemaVersion: 1,
    runId: randomUUID().replaceAll("-", ""),
    manifest,
    candidates,
    stages,
    runtimePins: [],
    acousticVerification: "unrun",
    mediaReadiness: "unclaimed",
  };
  try {
    const runtime = await (dependencies.verifyRuntime ?? verifyMediaRuntime)(config.media, {
      signalProcessGroup,
      signal: combined,
    });
    if (manifest.policy === VAD_RECOVERY_POLICY)
      runtime.vad = await (dependencies.verifyVad ?? verifyRecoveryVad)(
        { runtime, signal: combined },
        { signalProcessGroup, signal: combined },
      );
    report.runtimePins = runtime.artifacts.map(({ key, sha256 }) => ({ key, sha256 }));
    if (runtime.vad) report.runtimePins.push(runtime.vad.pin, runtime.vad.delegatePin);
    const boundary = await evaluationOutputRoot(config.media, config.media.mediaRoot, {
      ...(dependencies.volumeRoot ? { volumeRoot: dependencies.volumeRoot } : {}),
    });
    const relation = relative(boundary, output);
    if (
      !relation ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      relation.startsWith(sep)
    )
      throw recoveryFailure("RECOVERY_OUTPUT_INVALID");
    await assertMediaArtifactPath(output, boundary);
    const capacity = await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
      courses: config.courses,
    });
    await capacity.check({ path: output, boundary, bytes: manifest.budgets.maxOutputBytes });
    combined.throwIfAborted();
    await mkdir(output, { mode: 0o700 });
    ownsOutput = true;
    await mkdir(join(output, "work"), { mode: 0o700 });
    const budgetCheck = async (extraBytes = 0) => {
      combined.throwIfAborted();
      const bytes = await recoveryDirectoryBytes(output, manifest.budgets.maxOutputBytes, combined);
      if (bytes + extraBytes > manifest.budgets.maxOutputBytes)
        throw recoveryFailure("RECOVERY_OUTPUT_BUDGET");
      await capacity.check({ path: output, boundary, bytes: extraBytes });
    };
    put = async (name, value) => {
      if (name.includes("/") || name.includes("\\")) throw recoveryFailure();
      const body = Buffer.isBuffer(value)
        ? value
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2) + "\n";
      await budgetCheck(Buffer.byteLength(body));
      await writeFile(join(output, name), body, { flag: "wx", mode: 0o600 });
    };
    await put("plan.json", manifest);
    monitor = setInterval(() => {
      if (!pending)
        pending = budgetCheck()
          .catch((error) => controller.abort(error))
          .finally(() => {
            pending = null;
          });
    }, 1000);
    const execute = async (command, args, options) => {
      const started = Date.now();
      const entry = { stage: options.label, status: "unrun", wallMs: null };
      stages.push(entry);
      try {
        await budgetCheck();
        if (runtime.vad) await assertRecoveryVadInputs(runtime.vad, combined);
        const result = await (dependencies.runProcess ?? runMediaProcess)(command, args, {
          ...options,
          signal: combined,
          signalProcessGroup,
          timeoutMs: Math.min(
            options.timeoutMs ?? manifest.budgets.processTimeoutMs,
            manifest.budgets.processTimeoutMs,
          ),
          stdoutMaxBytes: options.stdoutMaxBytes ?? 1024 * 1024,
          stderrMaxBytes: 1024 * 1024,
        });
        await budgetCheck();
        entry.status = "passed";
        return result;
      } catch (error) {
        entry.status = "failed";
        throw error;
      } finally {
        entry.wallMs = Date.now() - started;
      }
    };
    for (const recording of manifest.recordings) {
      const recordingPaths = new Set([
        recording.source.path,
        recording.media.path,
        recording.original.path,
        recording.metadata.path,
        recording.state.path,
      ]);
      await assertRecoveryInputs(
        {
          protectedAbsences: manifest.protectedAbsences?.filter((input) =>
            recordingPaths.has(input.path),
          ),
          protectedInputs: manifest.protectedInputs.filter((input) =>
            recordingPaths.has(input.path),
          ),
        },
        combined,
      );
      const candidate = await createRecoveryCandidate(
        { recording, manifest, config, runtime, output, execute, put, signal: combined },
        dependencies,
      );
      candidate.files = [];
      for (const suffix of [
        "native-asr.json",
        "source.json",
        "assessment.json",
        ...(candidate.formatting === "passed" ? ["paragraphs.md"] : []),
      ]) {
        const name = `${recording.id}.${suffix}`;
        const file = await recoveryFile(join(output, name), {
          maximumBytes: 16 * 1024 ** 2,
          signal: combined,
        });
        candidate.files.push({ name, sha256: file.sha256, bytes: file.bytes });
      }
      candidates.push(candidate);
      checks.push(
        observation(
          recording.id,
          candidate.eligible ? "passed" : "blocked",
          candidate.eligible ? "RECOVERY_CANDIDATE_VALIDATED" : "RECOVERY_CANDIDATE_REVIEW",
          candidate.eligible
            ? "Source-preserving candidate passed native, lexical and timing plausibility checks; acoustic verification remains unrun."
            : "Retained candidate needs review; repetition or source/timing evidence blocks publication.",
          candidate.eligible ? null : ACTION,
          {
            sourceStructure: candidate.sourceStructure,
            timing: candidate.timing,
            flags: candidate.flags,
            formatting: candidate.formatting,
          },
        ),
      );
    }
    await assertRecoveryInputs(manifest, combined);
    if (runtime.vad) await assertRecoveryVadInputs(runtime.vad, combined);
  } catch (error) {
    failureError = error;
    report.failureCode = safeCode(error);
  } finally {
    clearInterval(monitor);
    await pending;
    clearTimeout(timer);
    if (combined.aborted && !isGlobalMediaSafetyFailure(failureError)) {
      failureError = combined.reason;
      report.failureCode = safeCode(failureError);
    }
    if (ownsOutput && put) {
      try {
        await retainRecoveryReport(output, report, manifest.budgets.maxOutputBytes);
        await dependencies.afterReportRetained?.();
      } catch (error) {
        if (!isGlobalMediaSafetyFailure(failureError)) failureError = error;
      }
    }
    if (combined.aborted && !isGlobalMediaSafetyFailure(failureError))
      failureError = combined.reason;
  }
  if (failureError) throw failureError;
  return {
    candidates: candidates.length,
    eligible: candidates.filter((candidate) => candidate.eligible).length,
    review: candidates.filter((candidate) => !candidate.eligible).length,
    publication: "unrun",
    mitigation: "unmeasured-context-limitation",
  };
}

async function retainRecoveryReport(output, report, maximumBytes) {
  // Evidence survives interruption; no candidate directory or work artifact is deleted.
  const content = JSON.stringify(report, null, 2) + "\n";
  const info = await lstat(output);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await recoveryDirectoryBytes(output, maximumBytes)) + Buffer.byteLength(content) > maximumBytes
  )
    throw recoveryFailure("RECOVERY_EVIDENCE_STORAGE");
  await writeFile(join(output, "recovery.json"), content, { flag: "wx", mode: 0o600 });
}

function safeCode(error) {
  return /^(?:RECOVERY|MEDIA)_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "RECOVERY_FAILED";
}
function failure(error) {
  const code = safeCode(error);
  return observation(
    "execution",
    code === "RECOVERY_ARGUMENTS" || code === "RECOVERY_VAD_UNPREPARED" || code.startsWith("MEDIA_")
      ? "blocked"
      : "failed",
    code,
    "Recovery stopped; private evidence and originals remain. No raw exception is exposed.",
    code === "RECOVERY_VAD_UNPREPARED"
      ? "Owner: run npm run media:setup -- vad with the pinned compatible runtime; retry unchanged inputs in a fresh candidate directory."
      : ACTION,
  );
}
