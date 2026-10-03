import { join, resolve, sep } from "node:path";
import { createProductionLocalModels } from "./production-local.mjs";
import { transcriptSegmentTime } from "./production-values.mjs";
import { validateTranscript, assertFormattedTranscript } from "./transcript.mjs";
import { historicalParagraphs, historicalTextFlags } from "./historical-format.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";

export async function createRecoveryCandidate(
  { recording, manifest, config, runtime, output, execute, put, signal },
  dependencies = {},
) {
  const setup = config.media.setup;
  const context = {
    setup,
    paths: { ...runtime.runtime, work: join(output, "work") },
    preserveArtifacts: true,
    asrPolicy: manifest.policy,
    vadModel: runtime.vad?.path,
    commands: {
      ffmpeg: join(runtime.runtime.bin, setup.mediaTool.filename),
      ffprobe: config.media.tools.ffprobe,
      whisper: join(runtime.runtime.bin, setup.asr.runtime.filename),
      llama: join(runtime.runtime.bin, setup.formatter.runtime.filename),
    },
    models: {
      asr: join(runtime.runtime.models, setup.asr.model.filename),
      formatter: join(runtime.runtime.models, setup.formatter.model.filename),
    },
  };
  let native;
  context.runProcess = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (options.label === "Whisper transcription") {
      const prefix = args[args.indexOf("-of") + 1];
      if (typeof prefix !== "string" || !resolve(prefix).startsWith(resolve(output) + sep))
        throw recoveryFailure();
      const file = await recoveryFile(`${prefix}.json`, {
        maximumBytes: Math.min(16 * 1024 ** 2, manifest.budgets.maxOutputBytes),
        signal,
      });
      await put(`${recording.id}.native-asr.json`, file.content);
      native = JSON.parse(file.content.toString("utf8"));
    }
    return result;
  };
  const probe = await execute(
    context.commands.ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", recording.media.path],
    { signal, label: "Recovery duration probe", stdoutMaxBytes: 64 * 1024 },
  );
  const duration = Number(JSON.parse(probe.stdout).format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > manifest.budgets.maxRecordingSeconds
  )
    throw recoveryFailure("RECOVERY_DURATION_BUDGET");
  const models = (dependencies.createModels ?? createProductionLocalModels)(context);
  let source;
  try {
    source = await models.transcriber.transcribe({
      media: { path: recording.media.path, kind: "audio", audioOnly: true },
      signal,
    });
  } finally {
    await models.transcriber.release?.();
  }
  await put(`${recording.id}.source.json`, source);
  if (!native) throw recoveryFailure("RECOVERY_NATIVE_OUTPUT_MISSING");
  const { candidate, markdown } = assessRecoveryTranscript({
    native,
    source,
    duration,
    id: recording.id,
  });
  if (markdown !== null) await put(`${recording.id}.paragraphs.md`, markdown);
  await put(`${recording.id}.assessment.json`, candidate);
  return candidate;
}

export function assessRecoveryTranscript({ native, source, duration, id }) {
  safeNativeTranscriptBody(native);
  const values = native.transcription ?? native.segments;
  if (!Array.isArray(values) || !values.length) throw recoveryFailure("RECOVERY_NATIVE_INVALID");
  const nativeSource = {
    sourceKind: "generated",
    language: source.language,
    segments: values.map((segment) => ({
      start: transcriptSegmentTime(segment, "from", "start"),
      end: transcriptSegmentTime(segment, "to", "end"),
      text: segment.text,
    })),
  };
  const nativeValidation = validateTranscript(nativeSource, { duration });
  const sourceValidation = validateTranscript(source, { duration });
  const flags = historicalTextFlags(
    values.map((segment) => (typeof segment.text === "string" ? segment.text : "")).join("\n"),
  );
  const structural = validateTranscript(nativeSource, {
    allowMissingDuration: true,
    coverageRatio: 0,
  });
  const unchangedSegments =
    structural.valid &&
    source.segments.length === values.length &&
    source.segments.every(
      (segment, index) =>
        segment.start === nativeSource.segments[index].start &&
        segment.end === nativeSource.segments[index].end &&
        segment.text === nativeSource.segments[index].text.trim(),
    );
  const eligible =
    unchangedSegments &&
    nativeValidation.valid &&
    sourceValidation.valid &&
    source.sourceKind === "generated" &&
    flags.length === 0;
  let markdown = null;
  if (unchangedSegments && sourceValidation.valid) {
    markdown = historicalParagraphs(source);
    assertFormattedTranscript(markdown, nativeSource.segments);
  }
  const candidate = {
    id,
    eligible,
    status: eligible ? "candidate" : "review",
    sourceStructure: unchangedSegments ? "passed" : "failed",
    timing: nativeValidation.valid && sourceValidation.valid ? "passed" : "failed",
    flags,
    duration,
    formatting: markdown === null ? "unrun" : "passed",
    acousticVerification: "unrun",
    mediaReadiness: "unclaimed",
    sourceCorrection: "none",
    mitigation: "unmeasured-context-limitation",
  };
  return { candidate, markdown };
}
