import { setTimeout, clearTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { recoveryFailure } from "./recovery-files.mjs";
import { historicalReads, historicalDigest, publishHistoricalFile } from "./historical-files.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { assertRecoveryInputs } from "./recovery-manifest.mjs";
import { unconfirmedMediaCleanupCode } from "./errors.mjs";
import { readMediaQueue } from "./queue.mjs";
import { VAD_MODEL } from "./vad-model.mjs";
import {
  vadPaths,
  vadPreparationBody,
  optionalVadFile,
  verifyVadCapabilities,
  verifyRecoveryVad,
} from "./vad.mjs";
const fail = () => recoveryFailure("RECOVERY_VAD_UNPREPARED");
async function download(spec, signal, fetcher, timeoutMs = 120000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw fail();
  const controller = new globalThis.AbortController(),
    timer = setTimeout(() => controller.abort(fail()), timeoutMs);
  const combined = signal
    ? globalThis.AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let aborted;
  const stopped = new Promise((_resolve, reject) => {
    aborted = () => reject(combined.reason);
    combined.addEventListener("abort", aborted, { once: true });
    if (combined.aborted) aborted();
  });
  const acquire = async () => {
    combined.throwIfAborted();
    const response = await fetcher(spec.source, { signal: combined });
    if (!response.ok || !response.body) throw fail();
    const parts = [];
    let bytes = 0;
    for await (const part of response.body) {
      combined.throwIfAborted();
      bytes += part.length;
      if (bytes > spec.bytes) {
        controller.abort();
        throw fail();
      }
      parts.push(Buffer.from(part));
    }
    const body = Buffer.concat(parts);
    if (bytes !== spec.bytes || historicalDigest(body) !== spec.sha256) throw fail();
    return body;
  };
  try {
    return await Promise.race([acquire(), stopped]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", aborted);
  }
}
export async function setupRecoveryVad({ config, signal, signalProcessGroup }, dependencies = {}) {
  let written = 0,
    cleanupCode = null,
    safetyBarrier = "unrun";
  try {
    return await (dependencies.lock ?? withMediaQueueLock)({
      statePath: config.statePath,
      run: async () => {
        try {
          await (dependencies.admission ?? assertMediaSafetyAdmission)({
            statePath: config.statePath,
            courses: config.courses,
            readQueue: readMediaQueue,
          });
          const runtime = await (dependencies.verifyRuntime ?? verifyMediaRuntime)(config.media, {
            signal,
            signalProcessGroup,
          });
          const options = { ...dependencies, signalProcessGroup, signal };
          const executable = await verifyVadCapabilities(runtime, signal, options);
          const spec = dependencies.spec ?? VAD_MODEL,
            paths = vadPaths(runtime.runtime),
            expected = vadPreparationBody(runtime.runtime, spec);
          const journal = await optionalVadFile(paths.journal, signal),
            receipt = await optionalVadFile(paths.receipt, signal),
            model = await optionalVadFile(paths.model, signal, spec.bytes);
          if (
            (journal && journal.content.toString("utf8") !== expected) ||
            (receipt && (!journal || receipt.content.toString("utf8") !== expected)) ||
            (model && (!journal || model.sha256 !== spec.sha256 || model.bytes !== spec.bytes)) ||
            (receipt && !model)
          )
            throw fail();
          const capacity = await (dependencies.createCapacity ?? createMediaCapacity)(
            config.media,
            dependencies.volumeRoot ? { volumeRoot: dependencies.volumeRoot } : {},
          );
          const reads = historicalReads({ signal });
          const inputs = [
            executable,
            ...[journal, receipt, model]
              .filter(Boolean)
              .map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
          ];
          const recheck = () => assertRecoveryInputs({ protectedInputs: inputs }, signal);
          const put = async (path, body) => {
            await recheck();
            const result = await publishHistoricalFile(path, Buffer.from(body), {
              reads,
              boundary: config.media.mediaRoot,
              expectedSha256: historicalDigest(body),
              checkCapacity: async (request) => {
                await capacity.check(request);
                await recheck();
              },
            });
            if (result === "written") written++;
            const proof = await optionalVadFile(path, signal, Math.max(16384, spec.bytes));
            if (!proof || proof.sha256 !== historicalDigest(body)) throw fail();
            inputs.push({ path, sha256: proof.sha256, bytes: proof.bytes });
            await dependencies.afterOutput?.(path);
          };
          if (!journal) await put(paths.journal, expected);
          if (!model) {
            await capacity.check({
              path: paths.model,
              boundary: config.media.mediaRoot,
              bytes: spec.bytes,
            });
            await put(
              paths.model,
              await download(
                spec,
                signal,
                dependencies.fetcher ?? globalThis.fetch,
                dependencies.downloadTimeoutMs,
              ),
            );
          }
          if (!receipt) await put(paths.receipt, expected);
          await verifyRecoveryVad({ runtime, signal }, options);
          return capabilityResult(
            "media:setup:vad",
            [
              observation(
                "optional-vad",
                "passed",
                "RECOVERY_VAD_PREPARED",
                "Pinned optional VAD model prepared; base runtime evidence unchanged.",
              ),
            ],
            {
              written,
              existing: Boolean(receipt),
              modelSha256: spec.sha256,
              acousticVerification: "unrun",
            },
          );
        } catch (error) {
          cleanupCode = unconfirmedMediaCleanupCode(error);
          try {
            await persistMediaSafetyBarrier({ statePath: config.statePath, error });
            if (cleanupCode) safetyBarrier = "retained";
          } catch (barrierError) {
            safetyBarrier = "write-failed";
            throw barrierError;
          }
          throw error;
        }
      },
    });
  } catch (error) {
    const admissionBlocked = error?.code === "MEDIA_SAFETY_BARRIER";
    const failureCode =
      safetyBarrier === "write-failed"
        ? "MEDIA_SAFETY_BARRIER_WRITE"
        : (cleanupCode ??
          (admissionBlocked ? "MEDIA_SAFETY_BARRIER" : "RECOVERY_VAD_SETUP_REFUSED"));
    const action =
      safetyBarrier === "write-failed"
        ? "Owner: retain external containment; restore durable safety evidence/storage and verify owned process/browser cessation before any retry."
        : cleanupCode || admissionBlocked
          ? "Owner: retain external containment, verify owned process/browser cessation and inspect preserved evidence before explicitly clearing safety barriers and queue safety markers; do not retry setup automatically."
          : "Inspect optional model/receipt and restore runtime/reserve; repeat npm run media:setup -- vad unchanged.";
    return capabilityResult(
      "media:setup:vad",
      [
        observation(
          "optional-vad",
          "blocked",
          failureCode,
          cleanupCode
            ? "Optional VAD preparation stopped; owned cleanup remains unconfirmed and retained bytes remain."
            : "Optional VAD preparation refused; retained bytes remain.",
          action,
        ),
      ],
      {
        written,
        failureCode,
        cleanup: cleanupCode ? "unconfirmed" : "unrun",
        cleanupCode,
        safetyBarrier: admissionBlocked ? "blocks-admission" : safetyBarrier,
        acousticVerification: "unrun",
      },
    );
  }
}
