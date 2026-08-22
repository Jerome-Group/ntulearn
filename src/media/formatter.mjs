import { FORMATTER_PROMPT_OPENING } from "./formatter-contract.mjs";

export const LOCAL_FORMATTING_RULES = Object.freeze([
  "Preserve the source language and all code-switching; never translate.",
  "Correct spelling, grammar, and obvious non-semantic noise only; never summarize.",
  "Do not invent headings or transitions. Add a heading only when the source explicitly transitions.",
  "Convert mathematical or symbolic notation only when unambiguous and keep the source wording nearby.",
  "Do not emit timestamps in the Markdown derivative.",
]);

export function cleanLocalFormatterOutput(stdout, prompt = "") {
  let output = String(stdout ?? "")
    // eslint-disable-next-line no-control-regex -- strip terminal escape sequences from CLI output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- strip terminal backspaces from CLI output
    .replace(/\x08/g, "")
    .replace(/\r\n?/g, "\n");
  const normalizedPrompt = String(prompt).replace(/\r\n?/g, "\n").trimEnd();
  if (normalizedPrompt) {
    output =
      removeRepeatedMarker(output, `> ${normalizedPrompt}`) ??
      removeRepeatedMarker(output, normalizedPrompt) ??
      output;
  }
  const cleaned = output.replace(/\n?\s*Exiting\.\.\.\s*$/i, "").trim();
  const fenced = cleaned.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i);
  return (fenced ? fenced[1] : cleaned).trim();
}

function removeRepeatedMarker(output, marker) {
  const first = output.indexOf(marker);
  if (first < 0) return null;
  return output
    .slice(first + marker.length)
    .split(marker)
    .join("");
}

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
        const text = segmentChunk.map(({ text: segmentText }) => segmentText).join(" ");
        const prompt = localFormatterPrompt({ language, text });
        const result = await model.generate({
          appearance,
          language,
          segments: segmentChunk,
          text,
          instructions: LOCAL_FORMATTING_RULES,
          prompt,
        });
        const markdown = cleanLocalFormatterOutput(
          typeof result === "string" ? result : result?.markdown,
          prompt,
        );
        if (markdown) outputs.push(markdown.trim());
        if (Array.isArray(result?.limitations)) limitations.push(...result.limitations);
      }
      return { markdown: outputs.join("\n\n"), limitations };
    },
  };
}

function localFormatterPrompt({ language, text }) {
  return [
    FORMATTER_PROMPT_OPENING,
    "Return only the Markdown transcript, with no preface, analysis, timestamps, or summary.",
    "Preserve every word, number, symbol, code-switched phrase, and their order. Correct only obvious spelling, grammar, and speech-recognition noise.",
    `Source language: ${language}`,
    "Rules:",
    ...LOCAL_FORMATTING_RULES.map((instruction) => `- ${instruction}`),
    "Transcript:",
    text,
  ].join("\n");
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
