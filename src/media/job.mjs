import { Buffer } from "node:buffer";
import { createMediaArtifacts, restoreMedia } from "./artifacts.mjs";
import { isGlobalMediaSafetyFailure, publicMediaError } from "./errors.mjs";
import { createMediaOutcome } from "./outcome.mjs";
import { parseProviderTranscript, validateTranscript } from "./transcript.mjs";

// The worker has one public seam: providers and playback capture resolve fresh data, storage owns
// placement, and the formatter stays local. No resolved provider object crosses into the result or
// artifact metadata.
export async function runMediaJob({
  appearance,
  provider,
  playbackCapture = null,
  storage,
  formatter,
  transcriber,
  clock = () => new Date(),
  signal,
}) {
  throwIfInterrupted(signal);
  const limitations = mediaLimitations(appearance);
  let retryable = appearance.retryable === true;
  const artifacts = {};
  let providerName = provider?.name ?? appearance.provider;
  const formatterVersion = nonEmpty(formatter?.version);
  let media = { video: unavailableMedia(), audio: unavailableMedia() };
  let source = null;
  let resolved = null;
  let nativeTranscript = null;
  let captureFailed = false;
  let sourceSha256 = null;
  const artifactsStore = createMediaArtifacts({ appearance, storage });
  const outcome = createMediaOutcome({ appearance, storage, clock });
  let existingMetadata = null;
  try {
    const existing = await artifactsStore.read();
    existingMetadata = existing?.metadata ?? null;
    throwIfInterrupted(signal);
    let acquiredMedia = existing?.retainedMedia ?? null;
    let asrReleased = true;
    sourceSha256 = existing?.sourceSha256 ?? null;

    if (existing) {
      source = existing.source;
      Object.assign(artifacts, existing.artifacts);
      providerName = existing.metadata?.provider ?? providerName;
      media = restoreMedia(existing.metadata?.media);
      limitations.push(
        ...(Array.isArray(existing.metadata?.limitations) ? existing.metadata.limitations : []),
      );
    }

    if (!existing || existing.replaceRawTranscript || !acquiredMedia) {
      try {
        resolved = await provider.resolve(appearance, { signal });
        throwIfInterrupted(signal);
      } catch (error) {
        throwIfCheckpointed(signal);
        throwIfGlobalSafety(error);
        retryable = true;
        limitations.push(`Provider resolution failed: ${publicMediaError(error)}`);
      }

      if (!source) {
        try {
          nativeTranscript = await provider.transcript(resolved, { signal });
          throwIfInterrupted(signal);
        } catch (error) {
          throwIfCheckpointed(signal);
          throwIfGlobalSafety(error);
          retryable = true;
          limitations.push(`Provider transcript retrieval failed: ${publicMediaError(error)}`);
        }

        if (nativeTranscript !== null && nativeTranscript !== undefined) {
          let providerBody;
          try {
            const body = nativeBody(nativeTranscript);
            assertSafeProviderTranscript(body);
            providerBody = body;
          } catch (error) {
            limitations.push(`Provider transcript rejected: ${publicMediaError(error)}.`);
          }

          if (providerBody !== undefined) {
            artifacts.providerTranscript = await storage.write({
              appearance,
              kind: "provider-transcript",
              content: providerBody,
              filename: nativeTranscript.filename ?? "transcript.provider",
            });

            try {
              const parsed = parseProviderTranscript(nativeTranscript);
              const checked = validateTranscript(parsed, {
                duration: resolved?.duration,
                speechDuration: resolved?.speechDuration,
              });
              if (checked.valid) source = checked.transcript;
              else limitations.push(`Provider transcript rejected: ${checked.reason}.`);
            } catch (error) {
              throwIfCheckpointed(signal);
              throwIfGlobalSafety(error);
              limitations.push(`Provider transcript rejected: ${publicMediaError(error)}.`);
            }
          }
        } else {
          limitations.push("No provider transcript was exposed.");
        }
      }

      if (!acquiredMedia) {
        try {
          const acquired = await provider.media(resolved, { signal });
          throwIfInterrupted(signal);
          if (acquired?.kind === "video" || acquired?.kind === "audio") {
            retryable ||= acquired.retryable === true;
            limitations.push(...mediaLimitations(acquired));
            ({ acquiredMedia, media } = await retainMedia({
              appearance,
              storage,
              artifacts,
              media,
              acquired,
            }));
          } else {
            retryable ||= acquired?.retryable === true;
            limitations.push(...mediaLimitations(acquired, "Provider returned no usable media."));
          }
        } catch (error) {
          throwIfCheckpointed(signal);
          throwIfGlobalSafety(error);
          retryable = true;
          limitations.push(`Media acquisition failed: ${publicMediaError(error)}`);
        }
      }
    }

    if (!acquiredMedia && playbackCapture) {
      try {
        const captured = await playbackCapture.media({ appearance, resolved, signal });
        if (signal?.aborted) {
          throw new Error("Browser playback capture interrupted; retry after the checkpoint.");
        }
        if (captured?.kind === "video" || captured?.kind === "audio") {
          retryable ||= captured.retryable === true;
          limitations.push(...mediaLimitations(captured));
          ({ acquiredMedia, media } = await retainMedia({
            appearance,
            storage,
            artifacts,
            media,
            acquired: captured,
          }));
        } else {
          captureFailed = true;
          retryable ||= captured?.retryable === true;
          limitations.push(
            ...mediaLimitations(captured, "Browser playback capture returned no usable media."),
          );
        }
      } catch (error) {
        throwIfCheckpointed(signal);
        throwIfGlobalSafety(error);
        captureFailed = true;
        retryable = true;
        limitations.push(captureErrorMessage(error));
      }
    }

    if (!source) {
      const generated = await generateLocalTranscript({
        appearance,
        transcriber,
        media: acquiredMedia,
        duration: resolved?.duration,
        speechDuration: resolved?.speechDuration,
        signal,
      });
      throwIfInterrupted(signal);
      source = generated.source;
      asrReleased = generated.released;
      limitations.push(...generated.limitations);
    }

    if (source && existing?.artifacts.formattedTranscript) {
      if (!artifacts.metadata) {
        artifacts.metadata = await artifactsStore.writeMetadata({
          providerName,
          source,
          sourceSha256,
          formattedSha256:
            existing.formattedSha256 ?? existing.artifacts.formattedTranscript?.sha256,
          formatterVersion: existing.metadata?.formatterVersion ?? formatterVersion,
          existingMetadata: existing.metadata,
          media,
          limitations,
        });
      }
      return outcome.persist({
        providerName,
        media,
        source,
        sourceSha256,
        artifacts,
        limitations,
        complete: !captureFailed,
        stage: captureFailed ? "red" : "complete",
        retryable: retryable || undefined,
        formatterVersion: existing.metadata?.formatterVersion ?? formatterVersion,
        existingMetadata: existing.metadata,
      });
    }

    if (source) {
      const raw = await artifactsStore.writeSource(source);
      artifacts.rawTranscript = raw.artifact;
      const rawBlocked = existing?.replaceRawTranscript && raw.artifact.status === "existing";
      sourceSha256 = rawBlocked ? null : (existing?.sourceSha256 ?? raw.sourceSha256);

      if (rawBlocked) {
        limitations.push("Existing raw transcript is invalid and cannot be replaced routinely.");
      } else if (!formatterVersion && source.sourceKind !== "non-speech") {
        limitations.push("Local formatter/model version is not configured.");
      } else {
        try {
          const formatted =
            source.sourceKind === "non-speech"
              ? { markdown: `No intelligible speech detected: ${source.reason}` }
              : asrReleased
                ? await formatter.format({
                    appearance,
                    language: source.language,
                    segments: source.segments,
                    signal,
                  })
                : null;
          if (!formatted) throw new Error("ASR resources were not released before formatting");
          if (Array.isArray(formatted?.limitations)) limitations.push(...formatted.limitations);
          artifacts.formattedTranscript = await artifactsStore.writeFormatted({
            source,
            sourceSha256,
            markdown: typeof formatted === "string" ? formatted : formatted?.markdown,
            replaceProof: existing?.formattedReplacement ?? null,
          });
          throwIfInterrupted(signal);
          artifacts.metadata = await artifactsStore.writeMetadata({
            providerName,
            source,
            sourceSha256,
            formattedSha256: artifacts.formattedTranscript.sha256,
            formatterVersion:
              source.sourceKind === "non-speech" ? "not used for non-speech" : formatterVersion,
            transcriber,
            existingMetadata: existing?.metadata,
            media,
            limitations,
          });
          return outcome.persist({
            providerName,
            media,
            source,
            sourceSha256,
            artifacts,
            limitations,
            complete: !captureFailed,
            stage: captureFailed ? "red" : "complete",
            retryable: retryable || undefined,
            formatterVersion:
              source.sourceKind === "non-speech" ? "not used for non-speech" : formatterVersion,
            transcriber,
            existingMetadata: existing?.metadata,
          });
        } catch (error) {
          throwIfCheckpointed(signal);
          throwIfGlobalSafety(error);
          limitations.push(`Formatted transcript rejected: ${publicMediaError(error)}`);
        }
      }
    } else if (!limitations.some((limitation) => /local transcription/i.test(limitation))) {
      limitations.push("Local transcription is not configured for this job.");
    }

    return outcome.persist({
      providerName,
      media,
      source,
      sourceSha256,
      artifacts,
      limitations,
      complete: false,
      stage: failureStage(limitations, captureFailed),
      retryable: retryable || undefined,
      formatterVersion,
      transcriber,
      existingMetadata,
    });
  } catch (error) {
    if (!isCheckpointError(error)) throw error;
    return outcome.persist({
      providerName,
      media,
      source,
      sourceSha256,
      artifacts,
      limitations: [
        ...limitations,
        "Media job checkpointed at 04:00; retry resumes from durable artifacts.",
      ],
      complete: false,
      stage: "checkpointed",
      retryable: true,
      formatterVersion,
      transcriber,
      existingMetadata,
    });
  }
}

function nativeBody(value) {
  const body = value?.body ?? value?.content ?? value;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return body;
  return Buffer.from(JSON.stringify(body));
}

function assertSafeProviderTranscript(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (/\b(?:ks|token|session|signature)\s*=/i.test(text)) {
    throw new Error("provider transcript contains a session-bound address");
  }
}

function unavailableMedia() {
  return { available: false, path: null, quality: null, audio: false };
}

async function retainMedia({ appearance, storage, artifacts, media, acquired }) {
  const artifact = await storage.write({
    appearance,
    kind: "media",
    mediaKind: acquired.kind,
    content: acquired.body,
    filename: acquired.filename,
  });
  artifacts.media = artifact;
  const acquiredMedia = { ...acquired, path: artifact.path };
  const nextMedia = { ...media };
  nextMedia[acquired.kind] = {
    available: true,
    path: artifact.path,
    quality: acquired.quality ?? null,
    audio: acquired.audio !== false || acquired.kind === "audio",
  };
  if (acquired.kind === "video" && acquired.audio !== false) {
    nextMedia.audio = { available: true, path: artifact.path, quality: null, audio: true };
  }
  return { acquiredMedia, media: nextMedia };
}

async function generateLocalTranscript({
  appearance,
  transcriber,
  media,
  duration,
  speechDuration,
  signal,
}) {
  if (!transcriber) {
    return {
      source: null,
      released: true,
      limitations: ["Local transcription is not configured for this job."],
    };
  }
  if (!usableTranscriptionMedia(media)) {
    return {
      source: null,
      released: true,
      limitations: ["Local transcription needs acquired video audio or audio-only media."],
    };
  }

  let source = null;
  const limitations = [];
  let released = true;
  try {
    const generated = await transcriber.transcribe({
      appearance,
      media,
      duration,
      speechDuration,
      signal,
    });
    throwIfInterrupted(signal);
    const candidate = {
      ...generated,
      sourceKind:
        generated?.sourceKind === "non-speech" ||
        generated?.kind === "non-speech" ||
        generated?.nonSpeech
          ? "non-speech"
          : "generated",
    };
    const checked = validateTranscript(candidate, { duration, speechDuration });
    if (checked.valid) source = checked.transcript;
    else limitations.push(`Local transcription rejected: ${checked.reason}.`);
  } catch (error) {
    throwIfCheckpointed(signal);
    throwIfGlobalSafety(error);
    limitations.push(`Local transcription failed: ${publicMediaError(error)}`);
  } finally {
    if (typeof transcriber.release === "function") {
      try {
        await transcriber.release();
      } catch (error) {
        throwIfCheckpointed(signal);
        throwIfGlobalSafety(error);
        released = false;
        limitations.push(`Local transcription cleanup failed: ${publicMediaError(error)}`);
      }
    }
  }
  return { source, released, limitations };
}

function throwIfInterrupted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : null;
  if (reason && reason.code !== "MEDIA_CHECKPOINT") return;
  const error = reason ?? new Error("Media job interrupted; retry after the queue checkpoint.");
  error.code ??= "MEDIA_CHECKPOINT";
  throw error;
}

function throwIfCheckpointed(signal) {
  if (signal?.aborted && signal.reason?.code === "MEDIA_CHECKPOINT") {
    throw signal.reason;
  }
}

function isCheckpointError(error) {
  return error?.code === "MEDIA_CHECKPOINT";
}

function throwIfGlobalSafety(error) {
  if (isGlobalMediaSafetyFailure(error)) throw error;
}

function usableTranscriptionMedia(media) {
  return Boolean(
    media &&
    (media.body !== undefined || media.path) &&
    (media.kind === "audio" || (media.kind === "video" && media.audio !== false)),
  );
}

function failureStage(limitations, captureFailed = false) {
  if (captureFailed) return "red";
  return limitations.some((limitation) =>
    /provider (?:resolution|transcript)|local transcription/i.test(limitation),
  )
    ? "pending"
    : "red";
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mediaLimitations(value, fallback = null) {
  const limitations = Array.isArray(value?.limitations) ? [...value.limitations] : [];
  if (value?.limitation) limitations.push(value.limitation);
  if (!limitations.length && fallback) limitations.push(fallback);
  return limitations;
}

function captureErrorMessage(error) {
  const message = publicMediaError(error);
  return /^(?:Browser playback capture failed|Playback cleanup failed):/.test(message)
    ? message
    : `Browser playback capture failed: ${message}`;
}
