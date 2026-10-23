/**
 * @typedef {{start: number, end: number, line: number, column: number,
 *   context: {start: number, end: number, text: string}}} Passage
 * Source offsets are UTF-16, zero-based and end-exclusive. Locations are one-based code points.
 */
export function searchMaterials(materials, { query = "", course = "", limits }) {
  const needle = query.toLowerCase();
  let remaining = limits.passagesPerSearch;
  return materials
    .filter((material) => !course || material.course.toLowerCase() === course.toLowerCase())
    .flatMap((material) => {
      const text = material.text.state === "read" ? material.text.value : "";
      const { passages, total } = occurrences(text);
      if (!material.path.toLowerCase().includes(needle) && !total) return [];
      const context = passages[0]?.context;
      const previewEnd = forward(text, 0, limits.previewCodePoints);
      const snippet = context
        ? `${context.start ? "…" : ""}${context.text}${context.end < text.length ? "…" : ""}`
        : total
          ? "Passage limit reached. Open this page to navigate its occurrences."
          : text
            ? `${text.slice(0, previewEnd)}${previewEnd < text.length ? "…" : ""}`
            : material.text.state === "read"
              ? "Empty Markdown document."
              : material.text.state === "filename-only"
                ? "Attachment filename only. Contents were not read."
                : "Document text unavailable. Inspect the scan diagnostics.";
      return [
        {
          ...material,
          match: total ? "text" : "filename",
          snippet,
          passages,
          occurrences: { total, returned: passages.length, omitted: total - passages.length },
        },
      ];
    });

  function occurrences(text) {
    const passages = [];
    if (!needle) return { passages, total: 0 };
    const folded = text.toLowerCase();
    let cursor;
    let source = 0;
    let lower = 0;
    let line = 1;
    let column = 1;
    let previous = "";
    let scalar = null;
    let lastStart = -1;
    let lastEnd = -1;
    let total = 0;
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, cursor)) {
      cursor = at + needle.length;
      while (!scalar || scalar.lowerEnd <= at) advance();
      const start = scalar.start;
      const location = { line: scalar.line, column: scalar.column };
      while (scalar.lowerEnd < cursor) advance();
      const end = scalar.end;
      if (start === lastStart && end === lastEnd) continue;
      lastStart = start;
      lastEnd = end;
      total += 1;
      if (passages.length >= limits.passagesPerDocument || !remaining) continue;
      const contextStart = backward(text, start, limits.contextCodePoints);
      const contextEnd = forward(text, end, limits.contextCodePoints);
      passages.push({
        start,
        end,
        ...location,
        context: {
          start: contextStart,
          end: contextEnd,
          text: text.slice(contextStart, contextEnd),
        },
      });
      remaining -= 1;
    }
    return { passages, total };

    function advance() {
      const character = String.fromCodePoint(text.codePointAt(source));
      const end = source + character.length;
      const lowerEnd = lower + character.toLowerCase().length;
      scalar = { start: source, end, lowerEnd, line, column };
      source = end;
      lower = lowerEnd;
      if (character === "\r") {
        line += 1;
        column = 1;
      } else if (character === "\n") {
        if (previous !== "\r") line += 1;
        column = 1;
      } else column += 1;
      previous = character;
    }
  }

  function backward(text, offset, count) {
    while (offset > 0 && count-- > 0) {
      offset -= 1;
      const unit = text.charCodeAt(offset);
      if (unit >= 0xdc00 && unit <= 0xdfff && offset > 0) {
        const prior = text.charCodeAt(offset - 1);
        if (prior >= 0xd800 && prior <= 0xdbff) offset -= 1;
      }
    }
    return offset;
  }

  function forward(text, offset, count) {
    while (offset < text.length && count-- > 0) offset += text.codePointAt(offset) > 0xffff ? 2 : 1;
    return offset;
  }
}
