import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isGlobalMediaSafetyFailure } from "./errors.mjs";
import { createLocalTranscriber } from "./asr.mjs";
import { cleanLocalFormatterOutput, createLocalFormatter } from "./formatter.mjs";
import { assertFormattedTranscript } from "./transcript.mjs";
import { readFormatterAssistant } from "./formatter-output.mjs";
import { transcriptSegmentTime } from "./production-values.mjs";
import { asrPolicyArguments } from "./recovery-policy.mjs";

const HOUR_MS = 60 * 60 * 1_000;

export function createProductionLocalModels(context) {
  const { setup } = context;
  return {
    transcriber: createLocalTranscriber({
      model: { transcribe: (input) => transcribe(input, context) },
      version: `${setup.asr.runtime.revision}/${setup.asr.model.revision}`,
      modelMetadata: setup.asr.model,
    }),
    formatter: createLocalFormatter({
      model: { generate: (input) => format(input, context) },
      version: `${setup.formatter.runtime.revision}/${setup.formatter.model.revision}`,
      maxSegments: 48,
      maxDuration: 300,
    }),
  };
}

async function transcribe(
  { media, signal },
  { paths, commands, models, runProcess, preserveArtifacts = false, asrPolicy = null },
) {
  const directory = await mkdtemp(join(paths.work, "asr-"));
  const audio = join(directory, "audio.flac");
  const output = join(directory, "transcript");
  let cleanupConfirmed = true;
  try {
    await runProcess(
      commands.ffmpeg,
      [
        "-nostats",
        "-y",
        "-i",
        media.path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "flac",
        audio,
      ],
      { signal, timeoutMs: 4 * HOUR_MS, label: "ASR audio extraction" },
    );
    await runProcess(
      commands.whisper,
      [
        "-m",
        models.asr,
        "-f",
        audio,
        "-oj",
        "-of",
        output,
        "-np",
        "-l",
        "auto",
        ...asrPolicyArguments(asrPolicy),
      ],
      { signal, timeoutMs: 8 * HOUR_MS, label: "Whisper transcription" },
    );
    return normalizeWhisper(JSON.parse(await readFile(`${output}.json`, "utf8")));
  } catch (error) {
    cleanupConfirmed = error.code !== "MEDIA_PROCESS_CLEANUP";
    throw error;
  } finally {
    if (cleanupConfirmed && !preserveArtifacts)
      await rm(directory, { recursive: true, force: true });
  }
}

function normalizeWhisper(result) {
  const segments = (result.transcription ?? result.segments ?? [])
    .map((segment, index) => ({
      index,
      start: transcriptSegmentTime(segment, "from", "start"),
      end: transcriptSegmentTime(segment, "to", "end"),
      text: String(segment.text ?? "").trim(),
    }))
    .filter(
      ({ start, end, text }) =>
        Number.isFinite(start) && Number.isFinite(end) && end > start && text,
    )
    .sort((left, right) => left.start - right.start || left.index - right.index)
    .map(({ index: _index, ...segment }) => segment);
  if (!segments.length) {
    throw new Error(
      "Whisper returned no timed transcript segments. Check the audio, then retry the media worker.",
    );
  }
  return {
    sourceKind: "generated",
    language: result.result?.language ?? result.language ?? "en",
    segments,
  };
}

async function format(
  { prompt, text, segments, signal },
  { paths, commands, models, runProcess, preserveArtifacts = false },
) {
  const directory = await mkdtemp(join(paths.work, "format-"));
  const promptFile = join(directory, "prompt.txt");
  const outputFile = join(directory, "assistant.txt");
  let cleanupConfirmed = true;
  try {
    await writeFile(promptFile, prompt, "utf8");
    await writeFile(outputFile, "", { flag: "wx", mode: 0o600 });
    await runProcess(
      commands.llama,
      [
        "-m",
        models.formatter,
        "-f",
        promptFile,
        "-c",
        "4096",
        "-n",
        "1024",
        "--temp",
        "0.1",
        "--no-display-prompt",
        "--no-show-timings",
        "--reasoning",
        "off",
        "--single-turn",
        "--output-file",
        outputFile,
      ],
      {
        signal,
        timeoutMs: 20 * 60 * 1_000,
        label: "Local transcript formatting",
        stdoutMaxBytes: 1024 * 1024,
      },
    );
    const assistant = await readFormatterAssistant(outputFile, { prompt, signal });
    const markdown = cleanLocalFormatterOutput(assistant)
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();
    try {
      return { markdown: assertFormattedTranscript(markdown, segments) };
    } catch {
      return fallback(text, "Local formatter output failed lexical preservation checks");
    }
  } catch (error) {
    cleanupConfirmed = error.code !== "MEDIA_PROCESS_CLEANUP";
    if (signal?.aborted || isGlobalMediaSafetyFailure(error) || error.code === "MEDIA_OUTPUT_LIMIT")
      throw error;
    return fallback(text, "Local formatter failed");
  } finally {
    if (cleanupConfirmed && !preserveArtifacts)
      await rm(directory, { recursive: true, force: true });
  }
}

function fallback(markdown, reason) {
  return {
    markdown,
    limitations: [
      `${reason}; preserved source transcript wording. Semantic equivalence is not proven.`,
    ],
  };
}
