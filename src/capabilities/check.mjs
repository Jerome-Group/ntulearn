import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkContracts } from "./contracts.mjs";
import { capabilityResult, observation } from "./result.mjs";
import { createCheckEvidence } from "./check-evidence.mjs";

const CHECKS = ["syntax", "contracts", "format", "lint", "test"];
const TIMEOUT_MS = 120000;

export async function runRepositoryChecks({
  root,
  selection = "all",
  node,
  run,
  contracts = checkContracts,
  clock = () => Date.now(),
  evidenceDirectory,
  evidenceOptions = {},
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
  let privateEvidence, evidenceFailure;
  if (evidenceDirectory !== undefined) {
    try {
      privateEvidence = await createCheckEvidence({
        ...evidenceOptions,
        root,
        directory: evidenceDirectory,
      });
    } catch (error) {
      return capabilityResult(
        "check",
        [
          evidenceObservation(error, true),
          ...requested.map((id) =>
            observation(
              id,
              "unrun",
              "EVIDENCE_REFUSED",
              "Check not run after private evidence refusal.",
            ),
          ),
        ],
        { selection },
      );
    }
  }
  const retain = async (record, check) => {
    if (!privateEvidence || evidenceFailure) return;
    try {
      const reference = await privateEvidence.record(record);
      check.evidence.privateEvidence = reference;
      check.action = `Inspect ${reference.reference.split("/")[1]}.invocation.json and its stdout/stderr logs in the requested private evidence directory. Repair the original failure, then rerun with a fresh evidence directory.`;
    } catch (error) {
      evidenceFailure = error;
      check.evidence.privateEvidence = privateEvidence.snapshot();
      check.action =
        "Inspect retained files in the requested private evidence directory and the separate private-evidence failure before a fresh rerun. The original check failure is unchanged.";
      results.push(evidenceObservation(error));
    }
  };
  for (const id of CHECKS) {
    if (!requested.includes(id)) {
      results.push(observation(id, "unrun", "NOT_SELECTED", "Check not selected."));
      continue;
    }
    if (evidenceFailure?.code === "CHECK_EVIDENCE_CLEANUP") {
      results.push(
        observation(
          id,
          "unrun",
          "EVIDENCE_CLEANUP_UNCONFIRMED",
          "Check not run after unconfirmed evidence I/O.",
        ),
      );
      continue;
    }
    const startedAt = clock();
    let lastInvocation = { id, ordinal: 1, command: "in-process-check", argumentsFor: [] };
    try {
      if (id === "contracts") {
        const checks = await contracts(root);
        results.push(...checks);
        const failed = checks.find((check) => check.status === "failed");
        if (failed)
          await retain(
            {
              id,
              ordinal: 1,
              command: "in-process-contracts",
              argumentsFor: [],
              result: { exitCode: 1, stdout: JSON.stringify(checks) },
            },
            failed,
          );
      } else {
        const invocations = await invocationsFor(id, root, node);
        let outputBytes = 0;
        const digest = createHash("sha256");
        let exitCode = 0;
        let timedOut = false;
        let checked = 0;
        let failedInvocation;
        for (const [command, argumentsFor] of invocations) {
          const remainingMs = TIMEOUT_MS - (clock() - startedAt);
          if (remainingMs <= 0) {
            timedOut = true;
            exitCode = 1;
            break;
          }
          lastInvocation = { id, ordinal: checked + 1, command, argumentsFor };
          const result = await run(command, argumentsFor, {
            cwd: root,
            timeout: remainingMs,
            ...(privateEvidence ? { retainOutput: true } : {}),
          });
          checked += 1;
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          outputBytes += Buffer.byteLength(output);
          digest.update(output);
          if (result.exitCode !== 0) {
            exitCode = result.exitCode ?? 1;
            timedOut = result.timedOut === true;
            failedInvocation = { id, ordinal: checked, command, argumentsFor, result };
            break;
          }
        }
        const check = observation(
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
        );
        results.push(check);
        if (failedInvocation) await retain(failedInvocation, check);
      }
    } catch (error) {
      const failed = observation(
        id,
        "failed",
        "CHECK_EXECUTION_FAILED",
        "Check could not execute; no raw exception exposed.",
        "Run npm ci --ignore-scripts, inspect the indexed check locally, then npm run check.",
      );
      results.push(failed);
      await retain(
        { ...lastInvocation, result: { exitCode: 1, stderr: String(error?.stack ?? error) } },
        failed,
      );
    }
  }
  const evidence = {
    selection,
    timeoutPerCheckMs: TIMEOUT_MS,
    staticTypes: "unrun: ESM JavaScript; syntax/lint/runtime contracts apply",
  };
  let result = capabilityResult("check", results, evidence);
  if (privateEvidence) {
    if (!evidenceFailure) {
      try {
        evidence.privateEvidence = await privateEvidence.finish(result);
      } catch (error) {
        evidenceFailure = error;
        results.push(evidenceObservation(error));
      }
    }
    if (evidenceFailure) evidence.privateEvidence = privateEvidence.snapshot();
    result = capabilityResult("check", results, evidence);
  }
  return result;
}

function evidenceObservation(error, preparing = false) {
  const code = error?.code?.startsWith("CHECK_EVIDENCE_") ? error.code : "CHECK_EVIDENCE_IO";
  const cleanup = code === "CHECK_EVIDENCE_CLEANUP";
  return observation(
    "private-evidence",
    preparing && !cleanup ? "blocked" : "failed",
    code,
    cleanup
      ? "Private evidence I/O or cleanup did not positively settle; original check results remain unchanged."
      : "Private evidence could not be retained; original check results remain unchanged.",
    cleanup
      ? "Retain the requested directory and inspect pending owned I/O before any retry. Do not overwrite or delete partial evidence."
      : "Inspect retained files in the requested private evidence directory; choose a fresh .scratch/check-evidence-<safe-name> directory and rerun the same check. Never overwrite earlier evidence.",
    { cleanup: cleanup ? "unconfirmed" : "confirmed" },
  );
}

export function parseCheckArguments(values) {
  const args = [...values];
  const selection = args[0] === "--evidence" ? undefined : args.shift();
  if (!args.length) return { selection };
  if (args.length !== 2 || args[0] !== "--evidence" || !args[1]) return null;
  return { selection, evidenceDirectory: args[1] };
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
