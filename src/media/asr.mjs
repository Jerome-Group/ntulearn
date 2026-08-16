import { normalizeTranscript } from "./transcript.mjs";

const MODEL_ORDER = Object.freeze(["small.en", "medium.en", "large-v3-turbo"]);

export const DEFAULT_ASR_REQUIREMENTS = Object.freeze({
  courseTerm: 0.9,
  mathematicalUtterance: 0.9,
  timestamp: 0.9,
  throughput: 1,
});

export function createLocalTranscriber({ model, version, modelMetadata, evaluation }) {
  if (!model || typeof model.transcribe !== "function") {
    throw new Error("Local transcriber needs a model.transcribe adapter.");
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("Local transcriber needs an ASR runtime/model version.");
  }

  const selectedModel = normalizeModelMetadata(modelMetadata, version);
  for (const field of ["name", "revision", "sha256", "license"]) {
    if (!selectedModel[field]) {
      throw new Error(`Local transcriber needs pinned ASR model metadata: ${field}.`);
    }
  }
  let released = false;

  return {
    version,
    runtimeMetadata: {
      selectedModel,
      ...(evaluation ? { evaluation } : {}),
    },

    async transcribe(input) {
      if (!usableMedia(input?.media)) {
        throw new Error("Local transcription needs acquired video audio or audio-only media.");
      }
      return normalizeAsrResult(await model.transcribe(input));
    },

    async release() {
      if (released) return;
      released = true;
      if (typeof model.release === "function") await model.release();
    },
  };
}

export async function evaluateAsrModels({
  candidates,
  fixtures,
  measure,
  requirements = DEFAULT_ASR_REQUIREMENTS,
}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error("ASR evaluation needs at least one candidate model.");
  }
  if (!Array.isArray(fixtures) || !fixtures.length) {
    throw new Error("ASR evaluation needs representative lecture fixtures.");
  }
  if (typeof measure !== "function") throw new Error("ASR evaluation needs a measure adapter.");

  const selectedRequirements = { ...DEFAULT_ASR_REQUIREMENTS, ...requirements };
  const evaluated = [];
  for (const candidate of candidates) {
    const model = normalizeModelMetadata(candidate);
    const metrics = normalizeMetrics(await measure({ candidate: model, fixtures }));
    evaluated.push({
      model,
      ...metrics,
      meetsRequirements: meetsRequirements(metrics, selectedRequirements),
    });
  }

  const selected = [...evaluated]
    .filter(({ meetsRequirements: meets }) => meets)
    .sort((left, right) => modelRank(left.model) - modelRank(right.model))[0];
  if (!selected) {
    throw new Error(
      "No evaluated ASR model meets the course-term, mathematics, timestamp, and throughput requirements.",
    );
  }

  return {
    candidates: evaluated,
    selectedModel: selected.model,
    requirements: selectedRequirements,
    selectionReason: `Selected smallest model meeting all ${Object.keys(selectedRequirements).join(", ")} requirements: ${selected.model.name}.`,
  };
}

function normalizeAsrResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Local ASR returned no transcript.");
  }
  const sourceKind =
    result.sourceKind ??
    (result.kind === "non-speech" || result.nonSpeech ? "non-speech" : "generated");
  return normalizeTranscript({
    sourceKind,
    language: result.language ?? result.lang ?? "und",
    segments: result.segments ?? result.transcript?.segments ?? [],
    reason: result.reason,
  });
}

function normalizeModelMetadata(value, fallbackName = "unknown") {
  const model = value && typeof value === "object" ? value : {};
  return {
    name: nonEmpty(model.name ?? model.id) ?? fallbackName,
    revision: nonEmpty(model.revision),
    sha256: nonEmpty(model.sha256),
    license: nonEmpty(model.license),
  };
}

function normalizeMetrics(value) {
  const metrics = value && typeof value === "object" ? value : {};
  return {
    courseTerm: numberOrNull(metrics.courseTerm),
    mathematicalUtterance: numberOrNull(metrics.mathematicalUtterance),
    timestamp: numberOrNull(metrics.timestamp),
    throughput: numberOrNull(metrics.throughput),
  };
}

function meetsRequirements(metrics, requirements) {
  return Object.entries(requirements).every(([key, minimum]) => {
    return Number.isFinite(metrics[key]) && metrics[key] >= minimum;
  });
}

function modelRank(model) {
  const rank = MODEL_ORDER.indexOf(model.name);
  return rank === -1 ? MODEL_ORDER.length : rank;
}

function usableMedia(media) {
  return Boolean(
    media &&
    (media.path || (media.body !== undefined && media.body !== null)) &&
    (media.kind === "audio" || (media.kind === "video" && media.audio !== false)),
  );
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
