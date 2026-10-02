import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

export async function assertDestinationPath(root, target) {
  const within = relative(resolve(root), resolve(target));
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new Error(
      "Unsafe destination path. Use a path inside the course destination, then run the same command again.",
    );
  }
  let path = resolve(root);
  for (const segment of within.split(sep).filter(Boolean)) {
    path = join(path, segment);
    const info = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new Error(
        "A course destination contains a symlink below its root. Use a destination without linked descendants, then run the same command again.",
      );
    }
    if (info === null) return;
  }
}
