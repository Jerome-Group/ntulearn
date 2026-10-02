const NUMBER_WORDS = Object.freeze({ zero: "0", one: "1", two: "2", three: "3" });
const MAX_ALIGNMENT_CELLS = 200_000_000;

export function referenceAlignment(reference, transcript) {
  if (reference.kind === "unavailable") return null;
  const expected = tokens(reference.text);
  const actual = tokens(transcript);
  if (!expected.length || expected.length * actual.length > MAX_ALIGNMENT_CELLS)
    throw new Error(
      "Reference alignment exceeds the bounded token budget. Use shorter declared fixtures, then retry.",
    );
  let previous = [0, 1, 2, 3].map(() => new Uint32Array(actual.length + 1));
  let current = [0, 1, 2, 3].map(() => new Uint32Array(actual.length + 1));
  for (let j = 0; j <= actual.length; j++) previous[0][j] = previous[3][j] = j;
  for (let i = 1; i <= expected.length; i++) {
    current[0][0] = current[2][0] = i;
    current[1][0] = current[3][0] = 0;
    for (let j = 1; j <= actual.length; j++) {
      const substitution = Number(expected[i - 1] !== actual[j - 1]);
      const diagonal = previous[0][j - 1] + substitution;
      const deletion = previous[0][j] + 1;
      const insertion = current[0][j - 1] + 1;
      const source =
        diagonal <= deletion && diagonal <= insertion
          ? previous
          : deletion <= insertion
            ? previous
            : current;
      const column =
        diagonal <= deletion && diagonal <= insertion ? j - 1 : deletion <= insertion ? j : j - 1;
      for (let field = 0; field < 4; field++) current[field][j] = source[field][column];
      if (diagonal <= deletion && diagonal <= insertion) {
        current[0][j] += substitution;
        current[1][j] += substitution;
      } else if (deletion <= insertion) {
        current[0][j]++;
        current[2][j]++;
      } else {
        current[0][j]++;
        current[3][j]++;
      }
    }
    [previous, current] = [current, previous];
  }
  const result = {
    edits: previous[0].at(-1),
    substitutions: previous[1].at(-1),
    deletions: previous[2].at(-1),
    insertions: previous[3].at(-1),
  };
  return {
    referenceKind: reference.kind,
    interpretation:
      reference.kind === "generated-script"
        ? "conditional alignment to declared synthesis input; acoustic fidelity unproven"
        : "alignment to declared listening annotation; annotation accuracy unverified",
    normalization:
      "Unicode words; case and punctuation normalized; zero/one/two/three mapped to digits",
    referenceTokens: expected.length,
    outputTokens: actual.length,
    substitutions: result.substitutions,
    deletions: result.deletions,
    insertions: result.insertions,
    conditionalWer: result.edits / expected.length,
    hallucinationsConfirmed: false,
  };
}

function tokens(value) {
  return [
    ...String(value)
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}]+/gu),
  ].map(([word]) => NUMBER_WORDS[word] ?? word);
}
