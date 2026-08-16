import { resolve, sep } from "node:path";
import { safeSegment } from "../paths.mjs";

export { orderedName, safeSegment } from "../paths.mjs";
const NUMBER_PREFIX = /^\d+ /;

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
