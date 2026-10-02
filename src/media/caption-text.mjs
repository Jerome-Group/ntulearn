const ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lrm: "\u200e",
  rlm: "\u200f",
  quot: '"',
  apos: "'",
});
const TAGS = new Set(["b", "i", "u", "c", "v", "lang", "ruby", "rt"]);

export function captionText(value) {
  const stack = [];
  const text = value.replace(/<([^<>]*)>/g, (original, payload) => {
    if (/^\d{1,2}:\d{2}(?::\d{2})?\.\d{3}$/.test(payload)) return "";
    const match = payload.match(/^(\/)?([a-z]+)(?:\.[^\s.>]+)*(?:\s+(.+))?$/i);
    if (!match) {
      if (/^\/?[a-z]/i.test(payload))
        throw new Error("Malformed WebVTT cue markup; original caption retained.");
      return original;
    }
    const [, close, name, annotation] = match;
    if (!TAGS.has(name))
      throw new Error("Unsupported WebVTT cue markup; original caption retained.");
    if (close) {
      if (annotation || stack.pop() !== name)
        throw new Error("Malformed WebVTT cue markup; original caption retained.");
      return name === "v" || name === "rt" ? " " : "";
    }
    if ((name === "v" || name === "lang") !== Boolean(annotation))
      throw new Error("Malformed WebVTT cue markup; original caption retained.");
    stack.push(name);
    if (name === "v") {
      const speaker = decodeEntities(annotation).trim();
      if (!speaker || /[[\]<>\r\n]/.test(speaker))
        throw new Error("Malformed WebVTT voice annotation; original caption retained.");
      return `[${annotation.trim()}] `;
    }
    return name === "rt" ? " " : "";
  });
  if (/<\/?[a-z]/i.test(text))
    throw new Error("Malformed WebVTT cue markup; original caption retained.");
  // WebVTT permits the end tag of a sole voice span to be omitted.
  if (stack.length && !(stack.length === 1 && stack[0] === "v"))
    throw new Error("Malformed WebVTT cue markup; original caption retained.");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? original;
    const point =
      entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : original;
  });
}
