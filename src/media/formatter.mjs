export const LOCAL_FORMATTING_RULES = Object.freeze([
  "Preserve the source language and all code-switching; never translate.",
  "Correct spelling, grammar, and obvious non-semantic noise only; never summarize.",
  "Do not invent headings or transitions. Add a heading only when the source explicitly transitions.",
  "Convert mathematical or symbolic notation only when unambiguous and keep the source wording nearby.",
  "Do not emit timestamps in the Markdown derivative.",
]);

export function createLocalFormatter({ model, version, maxSegments = 24, maxDuration = 120 }) {
  if (!model || typeof model.generate !== "function") {
    throw new Error("Local formatter needs a model.generate adapter.");
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("Local formatter needs a formatter/model version.");
  }
  if (!Number.isSafeInteger(maxSegments) || maxSegments <= 0) {
    throw new Error("Local formatter maxSegments must be a positive safe integer.");
  }
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
    throw new Error("Local formatter maxDuration must be positive.");
  }

  return {
    version,

    // Chunks are sent one at a time so the local model never needs the whole lecture in memory and
    // cannot reorder segments across a boundary. The job's semantic guards inspect the joined text.
    async format({ appearance, language, segments }) {
      const chunks = chunk(segments, maxSegments, maxDuration);
      const outputs = [];
      const limitations = [];
      for (const segmentChunk of chunks) {
        const result = await model.generate({
          appearance,
          language,
          segments: segmentChunk,
          text: segmentChunk.map(({ text }) => text).join(" "),
          instructions: LOCAL_FORMATTING_RULES,
        });
        const markdown = typeof result === "string" ? result : result?.markdown;
        if (markdown) outputs.push(markdown.trim());
        if (Array.isArray(result?.limitations)) limitations.push(...result.limitations);
      }
      return { markdown: outputs.join("\n\n"), limitations };
    },
  };
}

function chunk(values, maxSegments, maxDuration) {
  const chunks = [];
  let current = [];
  for (const value of values) {
    if (value.end - value.start > maxDuration) {
      throw new Error("Local formatter received a segment longer than maxDuration.");
    }
    const first = current[0];
    const elapsed = first ? value.end - first.start : 0;
    if (current.length && (current.length >= maxSegments || elapsed > maxDuration)) {
      chunks.push(current);
      current = [];
    }
    current.push(value);
  }
  if (current.length) chunks.push(current);
  return chunks;
}
