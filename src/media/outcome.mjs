import { durationLabel, positiveDuration } from "./duration.mjs";

export function createMediaOutcome({ appearance, storage, clock }) {
  return {
    async persist({
      providerName,
      media,
      source,
      sourceSha256,
      artifacts,
      limitations,
      complete,
      stage,
      retryable,
      formatterVersion,
      transcriber,
      existingMetadata,
      duration,
      speechDuration,
    }) {
      const result = mediaResult({
        appearance,
        providerName,
        media,
        source,
        sourceSha256,
        artifacts,
        limitations,
        complete,
        stage,
        retryable,
        duration,
        speechDuration,
      });
      artifacts.state = await writeState({
        appearance,
        providerName,
        media,
        source,
        sourceSha256,
        artifacts,
        stage: result.stage,
        complete: result.complete,
        retryable: result.retryable,
        limitations: result.limitations,
        formatterVersion,
        transcriber,
        existingMetadata,
        duration,
        speechDuration,
        storage,
        clock,
      });
      artifacts.status = await writeStatus({
        appearance,
        providerName,
        media,
        source,
        transcriptComplete: result.transcript.complete,
        stage: result.stage,
        verdict: result.verdict,
        retryable: result.retryable,
        formatterVersion,
        duration,
        speechDuration,
        limitations: result.limitations,
        storage,
        clock,
      });
      return result;
    },
  };
}

function mediaResult({
  appearance,
  providerName,
  media,
  source,
  sourceSha256,
  artifacts,
  limitations,
  complete,
  stage,
  retryable,
  duration,
  speechDuration,
}) {
  const finalLimitations = unique(limitations);
  const transcriptComplete = Boolean(
    source && sourceSha256 && artifacts.rawTranscript && artifacts.formattedTranscript,
  );
  const workflowComplete = complete && transcriptComplete;
  const verdict = workflowComplete ? (finalLimitations.length ? "yellow" : "green") : "red";

  return {
    recordingId: appearance.recordingId,
    provider: providerName,
    sourceKind: appearance.sourceKind,
    stage,
    verdict,
    complete: workflowComplete,
    transcript: {
      complete: transcriptComplete,
      sourceKind: source?.sourceKind ?? null,
      language: source?.language ?? null,
    },
    media,
    artifacts,
    limitations: finalLimitations,
    limitation: finalLimitations[0] ?? null,
    retryable: retryable ?? !workflowComplete,
    ...(positiveDuration(duration) ? { duration } : {}),
    ...(positiveDuration(speechDuration) ? { speechDuration } : {}),
  };
}

async function writeStatus({
  appearance,
  providerName,
  media,
  source,
  transcriptComplete,
  limitations,
  stage,
  verdict,
  retryable,
  formatterVersion,
  duration,
  speechDuration,
  storage,
  clock,
}) {
  return storage.write({
    appearance,
    kind: "status",
    content: statusMarkdown({
      appearance,
      providerName,
      media,
      source,
      transcriptComplete,
      limitations,
      stage,
      verdict,
      retryable,
      formatterVersion: formatterVersion ?? "not configured",
      duration,
      speechDuration,
      updatedAt: clock().toISOString(),
    }),
    filename: appearance.placement.statusPath,
  });
}

async function writeState({
  appearance,
  providerName,
  media,
  source,
  sourceSha256,
  artifacts,
  stage,
  complete,
  retryable,
  limitations,
  formatterVersion,
  transcriber,
  existingMetadata,
  duration,
  speechDuration,
  storage,
  clock,
}) {
  return storage.write({
    appearance,
    kind: "state",
    content:
      JSON.stringify(
        {
          version: 1,
          recordingId: appearance.recordingId,
          provider: providerName,
          formatterVersion: formatterVersion ?? null,
          stage,
          complete,
          retryable,
          ...(positiveDuration(duration) ? { duration } : {}),
          ...(positiveDuration(speechDuration) ? { speechDuration } : {}),
          sourceKind: source?.sourceKind ?? null,
          language: source?.language ?? null,
          sourceSha256: sourceSha256 ?? null,
          formattedSha256: artifacts.formattedTranscript?.sha256 ?? null,
          transcriberVersion: transcriber?.version ?? existingMetadata?.transcriberVersion ?? null,
          asr: transcriber?.runtimeMetadata ?? existingMetadata?.asr ?? null,
          media,
          artifacts: Object.fromEntries(
            Object.entries(artifacts)
              .filter(([kind]) => kind !== "state" && kind !== "status")
              .map(([kind, artifact]) => [kind, artifact?.path ?? null]),
          ),
          limitations,
          updatedAt: clock().toISOString(),
        },
        null,
        2,
      ) + "\n",
    filename: "transcript.state.json",
  });
}

function statusMarkdown({
  appearance,
  providerName,
  media,
  source,
  transcriptComplete,
  limitations,
  stage,
  verdict,
  retryable,
  formatterVersion,
  duration,
  speechDuration,
  updatedAt,
}) {
  const video = media.video.available
    ? `available${media.video.quality ? ` (${media.video.quality}p)` : ""}`
    : "unavailable";
  const audio = media.audio.available ? "available" : "unavailable";
  return [
    `# ${appearance.title} — media status`,
    "",
    `- Recording: ${appearance.recordingId}`,
    `- Provider: ${displayName(providerName)}`,
    `- Source: ${appearance.sourceKind}`,
    `- Video: ${video}`,
    `- Audio: ${audio}`,
    `- Media: ${mediaKind(media)}`,
    `- Duration: ${durationLabel(duration)}`,
    ...(positiveDuration(speechDuration)
      ? [`- Speech duration: ${durationLabel(speechDuration)}`]
      : []),
    `- Transcript provenance: ${transcriptLabel(source, transcriptComplete)}`,
    `- Formatter: ${formatterVersion}`,
    `- Stage: ${stage}`,
    `- Verdict: ${verdict}`,
    `- Retryable: ${retryable ? "yes" : "no"}`,
    `- Limitations: ${limitations.length ? limitations.join(" ") : "None"}`,
    `- Updated: ${updatedAt}`,
    "",
  ].join("\n");
}

function mediaKind(media) {
  if (media.video.available && media.audio.available) return "video with audio";
  if (media.video.available) return "video without audio";
  if (media.audio.available) return "audio-only";
  return "unavailable";
}

function transcriptLabel(source, complete) {
  if (!source) return "not complete";
  const label =
    source.sourceKind === "non-speech"
      ? `${source.language} non-speech source`
      : `${source.language} ${source.sourceKind} source`;
  return complete ? `${label} + formatted Markdown` : `${label}; formatted Markdown missing`;
}

function displayName(value) {
  return String(value ?? "unknown")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}
