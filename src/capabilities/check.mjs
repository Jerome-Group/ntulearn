import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkContracts } from "./contracts.mjs";
import { capabilityResult, observation } from "./result.mjs";

const CHECKS = ["syntax", "contracts", "format", "lint", "test"];
const TIMEOUT_MS = 120000;

export async function runRepositoryChecks({
  root,
  selection = "all",
  node,
  run,
  contracts = checkContracts,
  clock = () => Date.now(),
}) {
  if (!["all", ...CHECKS].includes(selection))
    return capabilityResult("check", [
      observation(
        "selection",
        "blocked",
        "CHECK_USAGE",
        "Unknown check selection.",
        "Run: npm run check -- <all|syntax|contracts|format|lint|test>",
      ),
    ]);
  const requested = selection === "all" ? CHECKS : [selection];
  const results = [];
  for (const id of CHECKS) {
    if (!requested.includes(id)) {
      results.push(observation(id, "unrun", "NOT_SELECTED", "Check not selected."));
      continue;
    }
    const startedAt = clock();
    try {
      if (id === "contracts") {
        results.push(...(await contracts(root)));
      } else {
        const invocations = await invocationsFor(id, root, node);
        let outputBytes = 0;
        const digest = createHash("sha256");
        let exitCode = 0;
        let timedOut = false;
        let checked = 0;
        for (const [command, argumentsFor] of invocations) {
          const remainingMs = TIMEOUT_MS - (clock() - startedAt);
          if (remainingMs <= 0) {
            timedOut = true;
            exitCode = 1;
            break;
          }
          const result = await run(command, argumentsFor, { cwd: root, timeout: remainingMs });
          checked += 1;
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          outputBytes += Buffer.byteLength(output);
          digest.update(output);
          if (result.exitCode !== 0) {
            exitCode = result.exitCode ?? 1;
            timedOut = result.timedOut === true;
            break;
          }
        }
        results.push(
          observation(
            id,
            exitCode === 0 ? "passed" : "failed",
            timedOut ? "CHECK_TIMEOUT" : exitCode === 0 ? "CHECK_PASSED" : "CHECK_FAILED",
            `${id} ${exitCode === 0 ? "passed" : "failed"}; outputs remain local.`,
            exitCode === 0
              ? null
              : `Run the indexed ${id} check locally; repair the reported failure, then npm run check.`,
            {
              exitCode,
              timedOut,
              invocations: checked,
              outputBytes,
              outputSha256: digest.digest("hex"),
              durationMs: Math.max(0, clock() - startedAt),
            },
          ),
        );
      }
    } catch {
      results.push(
        observation(
          id,
          "failed",
          "CHECK_EXECUTION_FAILED",
          "Check could not execute; no raw exception exposed.",
          "Run npm ci --ignore-scripts, inspect the indexed check locally, then npm run check.",
        ),
      );
    }
  }
  return capabilityResult("check", results, {
    selection,
    timeoutPerCheckMs: TIMEOUT_MS,
    staticTypes: "unrun: ESM JavaScript; syntax/lint/runtime contracts apply",
  });
}

async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
    }
  }
  await visit("src");
  await visit("test");
  files.push("eslint.config.mjs");
  return files.sort();
}

async function invocationsFor(id, root, node) {
  if (id === "syntax") return (await sourceFiles(root)).map((path) => [node, ["--check", path]]);
  if (id === "test") return [[node, ["--test"]]];
  const tools = {
    lint: ["eslint/bin/eslint.js", ["."]],
    format: ["prettier/bin/prettier.cjs", ["--check", "."]],
  };
  const [tool, argumentsFor] = tools[id];
  return [[node, [join(root, "node_modules", tool), ...argumentsFor]]];
}
