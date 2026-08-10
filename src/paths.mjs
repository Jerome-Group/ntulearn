import { resolve, sep } from "node:path";

export function safeSegment(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") || "untitled";
}

export function orderedName(position, name) {
  return `${String((position ?? 0) + 1).padStart(2, "0")} ${safeSegment(name)}`;
}

export function safeResolve(root, ...parts) {
  const target = resolve(root, ...parts.map(safeSegment));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe output path: ${target}`);
  }
  return target;
}
