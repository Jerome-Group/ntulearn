import { Buffer } from "node:buffer";
import {
  assertFormattedTranscript,
  rawTranscriptJson,
  transcriptDigest,
  validateTranscript,
} from "./transcript.mjs";

export function createMediaArtifacts({ appearance, storage }) {
  return {
    read: () => readExistingTranscript({ appearance, storage }),

    async writeSource(source) {
      const content = rawTranscriptJson(source);
      return {
        artifact: await storage.write({
          appearance,
          kind: "raw-transcript",
          content,
          filename: "transcript.raw.json",
        }),
        sourceSha256: transcriptDigest(content),
      };
    },

    async writeFormatted({ source, sourceSha256, markdown, replaceProof = null }) {
      const content = assertFormattedTranscript(markdown, source.segments);
      const artifact = await storage.write({
        appearance,
        kind: "formatted-transcript",
        content,
        filename: appearance.placement.formattedTranscriptPath,
        replaceProof: replaceProof
          ? { ...replaceProof, sourceSha256: replaceProof.sourceSha256 ?? sourceSha256 }
          : null,
      });
      if (artifact.status === "existing" && !replaceProof) {
        throw new Error("Formatted transcript exists without workflow ownership proof");
      }
      return { ...artifact, sha256: transcriptDigest(content) };
    },

    async writeMetadata({
      providerName,
      source,
      sourceSha256,
      formattedSha256,
      formatterVersion,
      transcriber,
      existingMetadata,
      media,
      limitations,
    }) {
      const metadata = transcriptMetadata({
        appearance,
        providerName,
        source,
        sourceSha256,
        formattedSha256,
        formatterVersion,
        transcriber,
        existingMetadata,
        media,
        limitations,
      });
      return storage.write({
        appearance,
        kind: "metadata",
        content: `${JSON.stringify(metadata, null, 2)}\n`,
        filename: "transcript.metadata.json",
      });
    },
  };
}

async function readExistingTranscript({ appearance, storage }) {
  if (typeof storage.read !== "function") return null;

  const rawTranscript = await storage.read({ appearance, kind: "raw-transcript" });
  const formattedArtifact = await storage.read({
    appearance,
    kind: "formatted-transcript",
  });
  const stateArtifact = await storage.read({ appearance, kind: "state" });
  const state = parseJson(stateArtifact?.content);
  const metadataArtifact = await storage.read({ appearance, kind: "metadata" });
  const parsedMetadata = parseJson(metadataArtifact?.content);
  const metadata = {
    ...(state
      ? {
          provider: state.provider,
          formatterVersion: state.formatterVersion,
          media: state.media,
          limitations: state.limitations,
          transcriberVersion: state.transcriberVersion,
          asr: state.asr,
          formattedSha256: state.formattedSha256,
        }
      : {}),
    ...(parsedMetadata ?? {}),
  };
  const mediaArtifact = state?.artifacts?.media
    ? { path: state.artifacts.media, status: "existing" }
    : null;
  const existingArtifacts = {
    ...(rawTranscript ? { rawTranscript } : {}),
    ...(mediaArtifact ? { media: mediaArtifact } : {}),
    ...(parsedMetadata ? { metadata: metadataArtifact } : {}),
    ...(stateArtifact ? { state: stateArtifact } : {}),
  };
  const retainedMedia = retainedMediaFromState(state, metadata.media);

  if (!rawTranscript) {
    if (!formattedArtifact && !stateArtifact && !metadataArtifact) return null;
    return {
      source: null,
      sourceSha256: null,
      metadata,
      replaceRawTranscript: true,
      formattedReplacement: null,
      retainedMedia,
      artifacts: existingArtifacts,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(textContent(rawTranscript.content));
  } catch {
    return {
      source: null,
      sourceSha256: null,
      metadata,
      replaceRawTranscript: true,
      formattedReplacement: null,
      retainedMedia,
      artifacts: existingArtifacts,
    };
  }
  const checked = validateTranscript(parsed, { allowMissingDuration: true, coverageRatio: 0 });
  if (!checked.valid) {
    return {
      source: null,
      sourceSha256: null,
      metadata,
      replaceRawTranscript: true,
      formattedReplacement: null,
      retainedMedia,
      artifacts: existingArtifacts,
    };
  }

  const sourceSha256 = transcriptDigest(textContent(rawTranscript.content));
  const formattedSha256 = formattedArtifact
    ? transcriptDigest(textContent(formattedArtifact.content))
    : null;
  const sourceOwnership = isWorkflowOwnedFormatted({
    artifact: formattedArtifact,
    state,
    metadata: parsedMetadata,
    sourceSha256,
  });
  const { formattedTranscript, formattedReplacement } = validateFormattedArtifact({
    artifact: formattedArtifact,
    segments: checked.transcript.segments,
    owned: sourceOwnership,
    expectedSha256: parsedMetadata?.formattedSha256 ?? state?.formattedSha256,
    sourceSha256,
  });
  const metadataIsCurrent = matchesSource(
    parsedMetadata,
    checked.transcript,
    sourceSha256,
    formattedSha256,
    appearance,
  );

  return {
    source: checked.transcript,
    sourceSha256,
    formattedSha256,
    metadata,
    replaceRawTranscript: false,
    formattedReplacement,
    retainedMedia,
    artifacts: {
      rawTranscript,
      ...(formattedTranscript ? { formattedTranscript } : {}),
      ...(metadataIsCurrent ? { metadata: metadataArtifact } : {}),
      ...(stateArtifact ? { state: stateArtifact } : {}),
    },
  };
}

function validateFormattedArtifact({ artifact, segments, owned, expectedSha256, sourceSha256 }) {
  if (!artifact) return { formattedTranscript: null, formattedReplacement: null };
  if (!owned) return { formattedTranscript: null, formattedReplacement: null };
  try {
    const content = assertFormattedTranscript(textContent(artifact.content), segments);
    const sha256 = transcriptDigest(content);
    if (expectedSha256 && expectedSha256 !== sha256) throw new Error("formatted digest mismatch");
    return {
      formattedTranscript: { ...artifact, sha256 },
      formattedReplacement: null,
    };
  } catch {
    return {
      formattedTranscript: null,
      formattedReplacement: {
        path: artifact.path,
        sha256: transcriptDigest(textContent(artifact.content)),
        sourceSha256,
      },
    };
  }
}

function matchesSource(metadata, source, sourceSha256, formattedSha256, appearance) {
  if (!metadata || typeof metadata !== "object") return false;
  return (
    metadata.recordingId === appearance.recordingId &&
    metadata.sourceSha256 === sourceSha256 &&
    metadata.formattedSha256 === formattedSha256 &&
    metadata.sourceKind === source.sourceKind &&
    metadata.language === source.language
  );
}

function isWorkflowOwnedFormatted({ artifact, state, metadata, sourceSha256 }) {
  if (!artifact || !sourceSha256) return false;
  const formattedSha256 = transcriptDigest(textContent(artifact.content));
  const sourceIsCurrent =
    state?.sourceSha256 === sourceSha256 || metadata?.sourceSha256 === sourceSha256;
  const derivativeIsOwned =
    metadata?.formattedSha256 === formattedSha256 ||
    (state?.artifacts?.formattedTranscript === artifact.path &&
      (!state.formattedSha256 || state.formattedSha256 === formattedSha256));
  return sourceIsCurrent && derivativeIsOwned;
}

function retainedMediaFromState(state, media) {
  const path = state?.artifacts?.media;
  if (!path) return null;
  if (media?.video?.available && media.video.path === path && media.video.audio) {
    return { kind: "video", path, audio: true };
  }
  if (media?.audio?.available && media.audio.path === path) {
    return { kind: "audio", path, audio: true };
  }
  return null;
}

function transcriptMetadata({
  appearance,
  providerName,
  source,
  sourceSha256,
  formattedSha256,
  formatterVersion,
  transcriber,
  existingMetadata,
  media,
  limitations,
}) {
  return {
    recordingId: appearance.recordingId,
    provider: providerName,
    sourceKind: source.sourceKind,
    recordingReference: appearance.providerReference,
    sourceSha256,
    formattedSha256,
    language: source.language,
    formatterVersion:
      formatterVersion ??
      (source.sourceKind === "non-speech" ? "not used for non-speech" : "unknown"),
    media,
    ...(source.sourceKind === "generated"
      ? {
          transcriberVersion: transcriber?.version ?? existingMetadata?.transcriberVersion ?? null,
          asr: transcriber?.runtimeMetadata ?? existingMetadata?.asr ?? null,
        }
      : {}),
    limitations: unique(limitations),
  };
}

export function restoreMedia(value) {
  return {
    video: restoreMediaKind(value?.video),
    audio: restoreMediaKind(value?.audio),
  };
}

function restoreMediaKind(value) {
  return {
    available: value?.available === true,
    path: typeof value?.path === "string" ? value.path : null,
    quality: Number.isFinite(value?.quality) ? value.quality : null,
    audio: value?.audio === true,
  };
}

function parseJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(textContent(value));
  } catch {
    return null;
  }
}

function textContent(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function unique(values) {
  return [...new Set(values)];
}
