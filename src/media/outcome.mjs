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
      formatterVersion,
      transcriber,
      existingMetadata,
    }) {
      const result = mediaResult({
        appearance,
        providerName,
        media,
        source,
        artifacts,
        limitations,
        complete,
        stage,
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
        storage,
        clock,
      });
      artifacts.status = await writeStatus({
        appearance,
        providerName,
        media,
        source,
        stage: result.stage,
        retryable: result.retryable,
        formatterVersion,
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
  artifacts,
  limitations,
  complete,
  stage,
}) {
  const finalLimitations = unique(limitations);
  const verdict = complete ? (finalLimitations.length ? "yellow" : "green") : "red";

  return {
    recordingId: appearance.recordingId,
    provider: providerName,
    sourceKind: appearance.sourceKind,
    stage,
    verdict,
    complete,
    transcript: {
      complete: Boolean(source && artifacts.formattedTranscript),
      sourceKind: source?.sourceKind ?? null,
      language: source?.language ?? null,
    },
    media,
    artifacts,
    limitations: finalLimitations,
    limitation: finalLimitations[0] ?? null,
    retryable: !complete,
  };
}

async function writeStatus({
  appearance,
  providerName,
  media,
  source,
  limitations,
  stage,
  retryable,
  formatterVersion,
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
      limitations,
      stage,
      retryable,
      formatterVersion: formatterVersion ?? "not configured",
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
  limitations,
  stage,
  retryable,
  formatterVersion,
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
    `- Transcript: ${source ? transcriptLabel(source) : "not complete"}`,
    `- Formatter: ${formatterVersion}`,
    `- Stage: ${stage}`,
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

function transcriptLabel(source) {
  if (source.sourceKind === "non-speech") return `${source.language} non-speech source`;
  return `${source.language} ${source.sourceKind} transcript`;
}

function displayName(value) {
  return String(value ?? "unknown")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}
