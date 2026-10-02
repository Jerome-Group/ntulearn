import { readFile, lstat } from "node:fs/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { join } from "node:path";
import { observation } from "../capabilities/result.mjs";
import { referenceAlignment } from "./evaluation-alignment.mjs";
import { createEvaluationProcess } from "./evaluation-process.mjs";
import { createProductionLocalModels } from "./production-local.mjs";
import { runMediaProcess } from "./process.mjs";
import { assertMediaArtifactPath } from "./storage.mjs";
import { validateTranscript, assertFormattedTranscript } from "./transcript.mjs";
import { transcriptSegmentTime } from "./production-values.mjs";
import { withEvaluationRead } from "./evaluation-read.mjs";
const ACTION =
  "Inspect the retained private evidence, correct inputs or restore runtime/storage, then retry with a new output directory.";

export async function evaluateFixture({
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
}) {
  const details = {
    id: fixture.id,
    referenceKind: fixture.reference.kind,
    sourceSha256: fixture.audio.sha256,
    referenceSha256: fixture.reference.sha256 ?? null,
    annotationQuality: "unverified",
    speechFidelity: "unrun",
    alignment: null,
    formatting: "unrun",
  };
  evidence.fixtures.push(details);
  const executeProcess =
    dependencies.runProcess ??
    ((command, args, options) =>
      runMediaProcess(command, args, { ...options, signalProcessGroup }));
  let interrupted = false;
  let nativeSegments = null;
  let nativeTranscript = null;
  let cancelTimer;
  const fixtureController = new globalThis.AbortController();
  const fixtureSignal = globalThis.AbortSignal.any([combined, fixtureController.signal]);
  const measured = createEvaluationProcess({
    runProcess: executeProcess,
    memoryMeasurement,
    timeoutMs: manifest.budgets.processTimeoutMs,
    signal: fixtureSignal,
    onStage: (stage) => evidence.stages.push({ fixture: fixture.id, ...stage }),
  });
  const bounded = async (command, args, options) => {
    if (options.label === "Whisper transcription" && manifest.interruptionAfterMs && !interrupted)
      cancelTimer = setTimeout(
        () => fixtureController.abort(coded("EVALUATION_INTERRUPTED")),
        manifest.interruptionAfterMs,
      );
    try {
      const result = await measured(command, args, options);
      await budgetCheck();
      if (options.label === "Whisper transcription") {
        await captureNative(args);
      }
      return result;
    } catch (error) {
      if (options.label === "Whisper transcription" && error?.code !== "MEDIA_PROCESS_CLEANUP") {
        await captureNative(args, "failed").catch((captureError) => {
          details.failedNativeOutputRetained = false;
          if (captureError?.globalSafety || captureError?.code === "EVALUATION_OUTPUT_BUDGET")
            throw captureError;
        });
      }
      throw error;
    } finally {
      clearTimeout(cancelTimer);
    }
  };
  async function captureNative(args, attempt = null) {
    const path = `${args[args.indexOf("-of") + 1]}.json`;
    const native = await withEvaluationRead(
      async (readSignal) => {
        await assertMediaArtifactPath(path, output);
        const info = await lstat(path);
        if (!info.isFile() || info.size > manifest.budgets.maxOutputBytes)
          throw coded("EVALUATION_OUTPUT_BUDGET");
        return readFile(path, { encoding: "utf8", signal: readSignal });
      },
      { signal: combined },
    );
    await put(`${fixture.id}${attempt ? `.${attempt}` : ""}.native-asr.json`, native);
    if (attempt) {
      details.failedNativeOutputRetained = true;
      return;
    }
    const parsed = JSON.parse(native);
    const segments = parsed.transcription ?? parsed.segments;
    if (Array.isArray(segments)) {
      const meaningful = segments.filter(({ text }) => typeof text === "string" && text.trim());
      nativeSegments = meaningful.length;
      nativeTranscript = {
        sourceKind: "generated",
        language: "und",
        segments: meaningful.map((segment) => ({
          start: transcriptSegmentTime(segment, "from", "start"),
          end: transcriptSegmentTime(segment, "to", "end"),
          text: segment.text,
        })),
      };
    }
  }
  const context = localContext(media, runtime.runtime, join(output, "work"), bounded);
  const probe = await measured(
    context.commands.ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", fixture.audio.path],
    {
      timeoutMs: manifest.budgets.processTimeoutMs,
      label: "Audio duration probe",
      stdoutMaxBytes: 64 * 1024,
    },
  );
  const duration = Number(JSON.parse(probe.stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > manifest.budgets.maxFixtureSeconds)
    throw coded("EVALUATION_DURATION_BUDGET");
  details.durationSeconds = duration;
  let models = (dependencies.createModels ?? createProductionLocalModels)(context);
  const input = {
    media: { path: fixture.audio.path, kind: "audio", audioOnly: true },
    signal: fixtureSignal,
  };
  let transcript;
  try {
    try {
      transcript = await models.transcriber.transcribe(input);
    } catch (error) {
      if (error?.code !== "EVALUATION_INTERRUPTED" || combined.aborted) throw error;
      interrupted = true;
      details.interruption = {
        status: "passed",
        recovery: "unrun",
        cleanup: "owned-group-confirmed",
      };
      // A fresh model adapter and signal recover the same immutable source; aborted adapters are discarded.
      const recovery = createEvaluationProcess({
        runProcess: executeProcess,
        memoryMeasurement,
        timeoutMs: manifest.budgets.processTimeoutMs,
        signal: combined,
        onStage: (stage) => evidence.stages.push({ fixture: fixture.id, recovery: true, ...stage }),
      });
      context.runProcess = async (command, args, options) => {
        const result = await recovery(command, args, options);
        await budgetCheck();
        if (options.label === "Whisper transcription") await captureNative(args);
        return result;
      };
      await models.transcriber.release?.();
      models = (dependencies.createModels ?? createProductionLocalModels)(context);
      transcript = await models.transcriber.transcribe({ ...input, signal: combined });
      details.interruption.recovery = "passed";
    }
    await put(`${fixture.id}.source-transcript.json`, transcript);
    const dropped = nativeSegments === null ? null : nativeSegments - transcript.segments.length;
    details.sourceStructure = {
      nativeSegments,
      normalizedSegments: transcript.segments.length,
      droppedSegments: dropped,
      status: dropped === null ? "unrun" : dropped === 0 ? "passed" : "failed",
    };
    if (dropped !== null && dropped !== 0)
      checks.push(
        observation(
          `${fixture.id}:source-structure`,
          "failed",
          "EVALUATION_ASR_SEGMENTS_DROPPED",
          "Native ASR and normalized source segment counts differ; inspect retained private source evidence.",
          ACTION,
        ),
      );
    const validation = validateTranscript(transcript, { duration });
    const nativeValidation = nativeTranscript
      ? validateTranscript(nativeTranscript, { duration })
      : null;
    details.nativeTimestamps = {
      status: nativeValidation ? (nativeValidation.valid ? "passed" : "failed") : "unrun",
      reason: nativeValidation?.reason ?? null,
    };
    if (nativeValidation && !nativeValidation.valid)
      checks.push(
        observation(
          `${fixture.id}:native-timestamps`,
          "failed",
          "EVALUATION_NATIVE_TIMESTAMPS_REJECTED",
          "Native ASR timestamps failed mandatory validation before normalization; inspect retained private evidence.",
          ACTION,
        ),
      );
    details.timestamps = {
      status: validation.valid ? "passed" : "failed",
      reason: validation.reason ?? null,
    };
    checks.push(
      observation(
        `${fixture.id}:timestamps`,
        validation.valid ? "passed" : "failed",
        validation.valid ? "EVALUATION_TIMESTAMPS_VALID" : "EVALUATION_TIMESTAMPS_REJECTED",
        validation.valid
          ? "Timestamp ordering, duration and coverage checks passed; speech coverage remains unmeasured."
          : "ASR failed mandatory timestamp/coverage checks; rejected evidence retained and formatting unrun.",
        validation.valid ? null : ACTION,
      ),
    );
    details.alignment = referenceAlignment(
      fixture.reference,
      transcript.segments.map(({ text }) => text).join(" "),
    );
    checks.push(
      observation(
        `${fixture.id}:acoustic-reference`,
        "blocked",
        "EVALUATION_ACOUSTIC_QUALITY_UNPROVEN",
        fixture.reference.kind === "annotated-audio"
          ? "Exact-byte annotation provenance supplied; annotation quality and listening review are unverified."
          : "No independently validated acoustic annotation; script alignment cannot establish speech fidelity.",
      ),
    );
    if (
      validation.valid &&
      nativeValidation?.valid !== false &&
      (dropped === null || dropped === 0)
    ) {
      const formatted = await models.formatter.format({
        language: transcript.language,
        segments: transcript.segments,
        signal: combined,
      });
      assertFormattedTranscript(formatted.markdown, transcript.segments);
      await put(`${fixture.id}.formatted.md`, formatted.markdown);
      details.formatting = "passed";
      details.formatterFallbacks = formatted.limitations?.length ?? 0;
      checks.push(
        observation(
          `${fixture.id}:formatting`,
          "passed",
          "EVALUATION_LEXICAL_PRESERVATION",
          "Formatter preserved lexical source identity; semantic equivalence remains unproven.",
        ),
      );
    } else {
      checks.push(
        observation(
          `${fixture.id}:formatting`,
          "unrun",
          "EVALUATION_FORMATTING_UNRUN",
          "Mandatory source checks rejected the transcript; formatting is unrun.",
          ACTION,
        ),
      );
    }
  } finally {
    await models.transcriber.release?.();
  }
}

function localContext(media, runtime, work, runProcess) {
  const setup = media.setup;
  return {
    setup,
    preserveArtifacts: true,
    paths: { ...runtime, work },
    runProcess,
    commands: {
      ffmpeg: join(runtime.bin, setup.mediaTool.filename),
      ffprobe: media.tools.ffprobe,
      whisper: join(runtime.bin, setup.asr.runtime.filename),
      llama: join(runtime.bin, setup.formatter.runtime.filename),
    },
    models: {
      asr: join(runtime.models, setup.asr.model.filename),
      formatter: join(runtime.models, setup.formatter.model.filename),
    },
  };
}

function coded(code) {
  const error = new Error(ACTION);
  error.code = code;
  return error;
}
