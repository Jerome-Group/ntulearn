import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import { historicalDigest, HISTORICAL_LIMITS } from "./historical-files.mjs";
import { unassociatedFiles, unassociatedFailure } from "./unassociated-files.mjs";
import {
  unassociatedInventory,
  unassociatedManifest,
  assertUnassociatedSnapshot,
} from "./unassociated-inventory.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";
import { unconfirmedMediaCleanupCode } from "./errors.mjs";
import { parseCatalogueMetadata } from "./catalogue-safety.mjs";

export const UNASSOCIATED_CONFIRMATION = "PUBLISH_UNASSOCIATED_REVIEW_EDITIONS";
const ACTION =
  "Inspect private plan, source flags and retained receipts; preserve containment after unconfirmed cleanup. Retry unchanged apply only after owned I/O is qualified; never replace user edits.";
export async function unassociatedTranscripts(
  { mode, manifestPath, config, signal, confirmation },
  dependencies = {},
) {
  let written = 0,
    existing = 0,
    executionCleanupCode,
    stateBoundaryProven = false;
  try {
    if (
      !["plan", "apply", "verify"].includes(mode) ||
      !manifestPath ||
      (mode === "apply" && confirmation !== UNASSOCIATED_CONFIRMATION)
    )
      throw unassociatedFailure("UNASSOCIATED_FORMAT_USAGE");
    const files = await unassociatedFiles(config, signal, dependencies.files);
    stateBoundaryProven = true;
    await files.permitted(manifestPath, { external: true });
    const execute = async () => {
      try {
        await files.io.probe(() =>
          assertMediaSafetyAdmission({
            statePath: config.statePath,
            courses: [],
            readQueue: async () => null,
          }),
        );
        const inventory = await unassociatedInventory(files),
          manifest = unassociatedManifest(inventory);
        const body = JSON.stringify(manifest, null, 2) + "\n";
        parseCatalogueMetadata(Buffer.from(body));
        await assertUnassociatedSnapshot(files, inventory);
        if (mode === "plan") {
          const status = await files.publish(manifestPath, body, {
            external: true,
            verifyInputs: () => assertUnassociatedSnapshot(files, inventory),
          });
          await assertUnassociatedSnapshot(files, inventory, { hash: true });
          return result(mode, inventory, {
            written: status === "written" ? 1 : 0,
            existing: status === "existing" ? 1 : 0,
          });
        }
        const retained = await files.read(manifestPath, true);
        if (JSON.stringify(parseCatalogueMetadata(retained.content)) !== JSON.stringify(manifest))
          throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
        const outputs = standaloneOutputs(inventory);
        if (
          outputs.reduce((n, o) => n + Buffer.byteLength(o.content), 0) >
          HISTORICAL_LIMITS.outputBytes
        )
          throw unassociatedFailure("UNASSOCIATED_FORMAT_LIMIT");
        const capacity =
          mode === "apply"
            ? await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
                courses: [],
              })
            : null;
        for (const output of outputs) {
          await assertUnassociatedSnapshot(files, inventory);
          await files.io.assertIdentity(retained);
          if (mode === "verify") {
            if ((await files.read(output.path)).sha256 !== historicalDigest(output.content))
              throw unassociatedFailure("UNASSOCIATED_FORMAT_OUTPUT_CHANGED");
          } else {
            const status = await files.publish(output.path, output.content, {
              verifyInputs: async () => {
                await assertUnassociatedSnapshot(files, inventory);
                await files.io.assertIdentity(retained);
              },
              checkCapacity: async (request) => {
                await capacity.check(request);
                await assertUnassociatedSnapshot(files, inventory);
                await files.io.assertIdentity(retained);
              },
            });
            if (status === "written") written++;
            else existing++;
          }
          await dependencies.afterOutput?.({ output, written, existing });
        }
        await assertUnassociatedSnapshot(files, inventory, { hash: true });
        if ((await files.read(manifestPath, true)).sha256 !== retained.sha256)
          throw unassociatedFailure("UNASSOCIATED_FORMAT_INPUT_CHANGED");
        return result(mode, inventory, { written, existing, outputs: outputs.length });
      } catch (error) {
        executionCleanupCode = unconfirmedMediaCleanupCode(error);
        throw error;
      }
    };
    return mode === "apply"
      ? await (dependencies.lock ?? withMediaQueueLock)({
          statePath: config.statePath,
          run: execute,
        })
      : await execute();
  } catch (caught) {
    let error = caught;
    const cleanupCode = unconfirmedMediaCleanupCode(error) ?? executionCleanupCode;
    let barrierPersistence = caught.code === "MEDIA_SAFETY_BARRIER_WRITE" ? "failed" : "unrun";
    if (cleanupCode && !stateBoundaryProven) barrierPersistence = "state-boundary-unproven";
    if (cleanupCode && stateBoundaryProven && barrierPersistence !== "failed")
      try {
        await (dependencies.persistBarrier ?? persistMediaSafetyBarrier)({
          statePath: config.statePath,
          error,
        });
        barrierPersistence = "passed";
      } catch (failure) {
        error = failure;
        barrierPersistence = "failed";
      }
    const known = [
      "UNASSOCIATED_FORMAT_USAGE",
      "UNASSOCIATED_FORMAT_INPUT_CHANGED",
      "UNASSOCIATED_FORMAT_OUTPUT_CHANGED",
      "UNASSOCIATED_FORMAT_LIMIT",
      "MEDIA_QUEUE_LOCK_HELD",
      "MEDIA_SAFETY_BARRIER",
      "MEDIA_SAFETY_BARRIER_WRITE",
    ];
    const code =
      error.code === "MEDIA_SAFETY_BARRIER_WRITE"
        ? error.code
        : (cleanupCode ??
          (known.includes(error.code) ? error.code : "UNASSOCIATED_FORMAT_EVIDENCE_INVALID"));
    return capabilityResult(
      `media:format-unassociated:${mode}`,
      [
        observation(
          "execution",
          code === "UNASSOCIATED_FORMAT_USAGE" ? "blocked" : "failed",
          code,
          "Standalone review publication stopped; exclusive partial outputs may remain. Originals retained.",
          ACTION,
        ),
      ],
      {
        written,
        existing,
        complete: false,
        ...(cleanupCode
          ? { cleanupCode, cleanup: "unconfirmed", containmentRequired: true, barrierPersistence }
          : {}),
        physicalIoCancellation: "unclaimed",
      },
    );
  }
}
function result(mode, inventory, counts) {
  return capabilityResult(
    `media:format-unassociated:${mode}`,
    [
      observation(
        "presentation",
        "passed",
        "UNASSOCIATED_FORMAT_" + mode.toUpperCase(),
        "Review-only source paragraphs retained; course association and readiness unverified.",
      ),
    ],
    {
      ...counts,
      planId: inventory.id,
      sources: inventory.sources.length,
      eligible: inventory.sources.filter((s) => s.eligible).length,
      invalid: inventory.sources.filter((s) => !s.valid).length,
      metadataPresentExcluded: inventory.excluded.length,
      sourceFlags: inventory.sources.filter((s) => s.sourceFlags.length).length,
      association: "unverified-by-this-edition",
      reading: "review-only",
      complete: false,
      sourceCorrection: "none",
      mediaReadiness: "unclaimed",
      acousticQuality: "unrun",
      modelCalls: 0,
    },
  );
}
function standaloneOutputs(inventory) {
  const root = join(inventory.root, "Unassociated", "Review", inventory.id),
    outputs = [];
  const link = (path) => `<${pathToFileURL(path).href}>`;
  const sources = inventory.sources.filter((s) => s.eligible);
  for (const source of sources) {
    const path = join(root, source.id + ".md");
    const content = `# Review only\n\nAssociation: unproven by this edition. No course attribution or readiness claim.\n\nSource flags: ${source.sourceFlags.join(", ") || "none"}. Timing: ${source.timing}. Acoustic verification: unrun.\n\n[Original retained raw source](${link(source.pin.path)})\n\n${source.markdown}\n`;
    const provenance = {
      schemaVersion: 1,
      policy: inventory.policy,
      formatter: inventory.formatter,
      sourceId: source.id,
      sourcePath: source.pin.path,
      sourceSha256: source.pin.sha256,
      editionSha256: historicalDigest(content),
      association: source.association,
      reading: source.reading,
      sourceFlags: source.sourceFlags,
      timing: source.timing,
      complete: false,
      sourceCorrection: "none",
      acousticQuality: "unrun",
      mediaReadiness: "unclaimed",
    };
    outputs.push(
      { path, content },
      { path: path + ".provenance.json", content: JSON.stringify(provenance, null, 2) + "\n" },
    );
  }
  outputs.push({
    path: join(root, "index.md"),
    content:
      "# Unassociated review reading\n\nCourse association unverified by these editions. Source wording and flags retained; no media readiness or acoustic claim.\n\n" +
      sources
        .map(
          (s) =>
            `- [Review source ${s.id}](${link(join(root, s.id + ".md"))}) — flags: ${s.sourceFlags.join(", ") || "none"}; timing: ${s.timing}.`,
        )
        .join("\n") +
      "\n\n" +
      inventory.sources
        .filter((s) => !s.eligible)
        .map(
          (s) =>
            `- No reading edition: [retained source](${link(s.pin.path)}) — source validity: ${s.valid}; flags: ${s.sourceFlags.join(", ") || "non-speech-or-ineligible"}.`,
        )
        .join("\n") +
      "\n",
  });
  return outputs;
}
