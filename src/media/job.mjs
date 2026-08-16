import { Buffer } from "node:buffer";
import {
  assertFormattedTranscript,
  parseProviderTranscript,
  rawTranscriptJson,
  transcriptDigest,
  validateTranscript,
} from "./transcript.mjs";

// The worker has one public seam: providers resolve fresh data, storage owns placement, and the
// formatter stays local. No resolved provider object crosses into the result or artifact metadata.
export async function runMediaJob({
  appearance,
  provider,
  storage,
  formatter,
  clock = () => new Date(),
}) {
  const limitations = [];
  const artifacts = {};
  const providerName = provider?.name ?? appearance.provider;
  const formatterVersion = nonEmpty(formatter?.version);
  const media = { video: unavailableMedia(), audio: unavailableMedia() };
  let source = null;
  let resolved = null;
  let nativeTranscript = null;

  try {
    resolved = await provider.resolve(appearance);
  } catch (error) {
    limitations.push(`Provider resolution failed: ${publicError(error)}`);
  }

  if (resolved) {
    try {
      nativeTranscript = await provider.transcript(resolved);
    } catch (error) {
      limitations.push(`Provider transcript retrieval failed: ${publicError(error)}`);
    }

    if (nativeTranscript !== null && nativeTranscript !== undefined) {
      artifacts.providerTranscript = await storage.write({
        appearance,
        kind: "provider-transcript",
        content: nativeBody(nativeTranscript),
        filename: nativeTranscript.filename ?? "transcript.provider",
      });

      try {
        const parsed = parseProviderTranscript(nativeTranscript);
        const checked = validateTranscript(parsed, {
          duration: resolved.duration,
          speechDuration: resolved.speechDuration,
        });
        if (checked.valid) source = checked.transcript;
        else limitations.push(`Provider transcript rejected: ${checked.reason}.`);
      } catch (error) {
        limitations.push(`Provider transcript rejected: ${publicError(error)}.`);
      }
    } else {
      limitations.push("No provider transcript was exposed.");
    }

    try {
      const acquired = await provider.media(resolved);
      if (acquired?.kind === "video" || acquired?.kind === "audio") {
        const artifact = await storage.write({
          appearance,
          kind: "media",
          mediaKind: acquired.kind,
          content: acquired.body,
          filename: acquired.filename,
        });
        artifacts.media = artifact;
        media[acquired.kind] = {
          available: true,
          path: artifact.path,
          quality: acquired.quality ?? null,
          audio: acquired.audio !== false || acquired.kind === "audio",
        };
        if (acquired.kind === "video" && acquired.audio !== false) {
          media.audio = { available: true, path: artifact.path, quality: null, audio: true };
        }
      } else {
        limitations.push(acquired?.limitation ?? "Provider returned no usable media.");
      }
    } catch (error) {
      limitations.push(`Media acquisition failed: ${publicError(error)}`);
    }
  }

  if (source) {
    const rawJson = rawTranscriptJson(source);
    artifacts.rawTranscript = await storage.write({
      appearance,
      kind: "raw-transcript",
      content: rawJson,
      filename: "transcript.raw.json",
    });
    const sourceSha256 = transcriptDigest(rawJson);

    if (!formatterVersion) {
      limitations.push("Local formatter/model version is not configured.");
    } else {
      try {
        const formatted = await formatter.format({
          appearance,
          language: source.language,
          segments: source.segments,
        });
        if (Array.isArray(formatted?.limitations)) limitations.push(...formatted.limitations);
        const markdown = assertFormattedTranscript(
          typeof formatted === "string" ? formatted : formatted?.markdown,
          source.segments,
        );
        artifacts.formattedTranscript = await storage.write({
          appearance,
          kind: "formatted-transcript",
          content: markdown,
          filename: appearance.placement.formattedTranscriptPath,
        });

        const metadata = {
          recordingId: appearance.recordingId,
          provider: providerName,
          sourceKind: "provider",
          recordingReference: appearance.providerReference,
          sourceSha256,
          language: source.language,
          formatterVersion,
          limitations: unique(limitations),
        };
        artifacts.metadata = await storage.write({
          appearance,
          kind: "metadata",
          content: `${JSON.stringify(metadata, null, 2)}\n`,
          filename: "transcript.metadata.json",
        });
        const result = mediaResult({
          appearance,
          providerName,
          media,
          source,
          artifacts,
          limitations,
          complete: true,
          stage: "complete",
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
      } catch (error) {
        limitations.push(`Formatted transcript rejected: ${publicError(error)}`);
      }
    }
  } else if (!limitations.some((limitation) => /local transcription/i.test(limitation))) {
    limitations.push("Local transcription is not configured for this job.");
  }

  const result = mediaResult({
    appearance,
    providerName,
    media,
    source,
    artifacts,
    limitations,
    complete: false,
    stage: failureStage(limitations),
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
      sourceKind: source ? "provider" : null,
      language: source?.language ?? null,
    },
    media,
    artifacts,
    limitations: finalLimitations,
    limitation: finalLimitations[0] ?? null,
    retryable: !complete || finalLimitations.length > 0,
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

function nativeBody(value) {
  const body = value?.body ?? value?.content ?? value;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return body;
  return Buffer.from(JSON.stringify(body));
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
    `- Transcript: ${source ? `${source.language} provider transcript` : "not complete"}`,
    `- Formatter: ${formatterVersion}`,
    `- Stage: ${stage}`,
    `- Retryable: ${retryable ? "yes" : "no"}`,
    `- Limitations: ${limitations.length ? limitations.join(" ") : "None"}`,
    `- Updated: ${updatedAt}`,
    "",
  ].join("\n");
}

function unavailableMedia() {
  return { available: false, path: null, quality: null, audio: false };
}

function displayName(value) {
  return String(value ?? "unknown")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function publicError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/https?:\/\/[^\s)]+/gi, "[provider address omitted]")
    .replace(/\b(ks|token|session|signature)=[^\s&]+/gi, "$1=[redacted]");
}

function unique(values) {
  return [...new Set(values)];
}

function failureStage(limitations) {
  return limitations.some((limitation) =>
    /provider (?:resolution|transcript)|local transcription/i.test(limitation),
  )
    ? "pending"
    : "red";
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
