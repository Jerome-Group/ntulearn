import { lstat, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { capabilityIndex } from "./index.mjs";
import { observation } from "./result.mjs";

export async function checkContracts(
  root,
  { read = readFile, inspect = lstat, exists = access, index = capabilityIndex() } = {},
) {
  const checks = [];
  const packageJson = JSON.parse(await read(join(root, "package.json"), "utf8"));
  const scripts = Object.keys(packageJson.scripts).sort();
  const indexed = index.commands.map((command) => command.script).sort();
  checks.push(
    observation(
      "command-index",
      scripts.join("\0") === indexed.join("\0") ? "passed" : "failed",
      "COMMAND_SCRIPT_PARITY",
      "Every npm script must have exactly one classified capability.",
      "Update the command index and its regression when a command changes.",
    ),
  );
  let missing = 0;
  const paths = new Set(
    index.features.flatMap((feature) => [...feature.code, ...feature.verification.tests]),
  );
  for (const path of paths) {
    try {
      await exists(join(root, path));
    } catch {
      missing += 1;
    }
  }
  checks.push(
    observation(
      "feature-routes",
      missing ? "failed" : "passed",
      "FEATURE_ROUTES",
      "Feature code and verification routes must resolve in a clean checkout.",
      missing ? "Repair stale capability routes; do not suppress the verifier." : null,
      { routes: paths.size, missing },
    ),
  );
  const claude = await inspect(join(root, "CLAUDE.md")).catch(() => null);
  checks.push(
    observation(
      "agent-instructions",
      claude?.isSymbolicLink() ? "passed" : "failed",
      "AGENT_SYMLINK",
      "CLAUDE.md must remain a symlink.",
      claude?.isSymbolicLink() ? null : "Restore the tracked symlink to AGENTS.md.",
    ),
  );
  const map = await exists(join(root, "MAP.md")).then(
    () => true,
    () => false,
  );
  checks.push(
    observation(
      "map",
      map ? "passed" : "failed",
      "MAP_PRESENT",
      "MAP.md must exist.",
      map ? null : "Restore the root orientation map.",
    ),
  );
  return checks;
}
