import { resolve, sep } from "node:path";

// eslint-disable-next-line no-control-regex -- control characters are what this strips
const RESERVED_CHARACTERS = /[\\/:*?"<>|\x00-\x1F]/g;
const NUMBER_PREFIX = /^\d+ /;

export function safeSegment(value) {
  return (
    String(value ?? "")
      .normalize("NFKC")
      .replace(RESERVED_CHARACTERS, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") || "untitled"
  );
}

export function orderedName(position, name) {
  return `${String((position ?? 0) + 1).padStart(2, "0")} ${safeSegment(name)}`;
}

// The name without the number `orderedName` put in front of it. A position is an ordering rather
// than an identity — insert an item upstream and every later one moves — so this is what two names
// have in common when only the ordering changed (#67).
export function unnumbered(name) {
  return name.replace(NUMBER_PREFIX, "");
}

export function safeResolve(root, ...parts) {
  const target = resolve(root, ...parts.map(safeSegment));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe output path: ${target}`);
  }
  return target;
}
