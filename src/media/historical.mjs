import { Buffer } from "node:buffer";
import { dirname, join, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { historicalInventory } from "./historical-inventory.mjs";
import { HISTORICAL_FORMAT_VERSION } from "./historical-format.mjs";
import {
  historicalReads,
  historicalDigest,
  historicalFailure,
  publishHistoricalFile,
  HISTORICAL_LIMITS,
  insideHistoricalRoot,
} from "./historical-files.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { capabilityResult, observation } from "../capabilities/result.mjs";

const ACTION =
  "Inspect the private manifest and checkpoint receipts, restore accessible storage or correct associations, then retry plan; all originals are retained.";

export async function historicalTranscripts(
  { mode, manifestPath, config, signal },
  dependencies = {},
) {
  const reads = historicalReads({ signal });
  try {
    if (!["plan", "apply", "verify"].includes(mode) || !manifestPath) throw historicalFailure();
    const execute = async () => {
      const inventory = await historicalInventory({ config, signal, reads });
      const manifest = manifestOf(inventory);
      if (mode === "plan") {
        const parent = await reads.probe(() => realpath(dirname(manifestPath)));
        if (
          dirname(manifestPath) !== parent ||
          manifestPath === config.statePath ||
          (config.profilePath &&
            (manifestPath === config.profilePath ||
              insideHistoricalRoot(config.profilePath, manifestPath))) ||
          inventory.roots.some(
            (root) => manifestPath === root.path || insideHistoricalRoot(root.path, manifestPath),
          )
        )
          throw historicalFailure();
        const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
        if (body.length > HISTORICAL_LIMITS.fileBytes) throw historicalFailure();
        await publishHistoricalFile(manifestPath, body, {
          reads,
          boundary: parent,
          expectedSha256: historicalDigest(body),
        });
        return result(mode, inventory, { manifestPath });
      }
      const retained = JSON.parse((await reads.read(manifestPath)).content.toString("utf8"));
      if (JSON.stringify(retained) !== JSON.stringify(manifest)) throw historicalFailure();
      const outputs = plannedOutputs(inventory);
      const receiptContent = (output) =>
        JSON.stringify(
          {
            schemaVersion: 1,
            planId: inventory.id,
            outputPath: output.path,
            outputSha256: historicalDigest(output.content),
            sourceSha256: output.sourceSha256 ?? null,
            stage: "published",
            originalUnchanged: true,
            mediaReadiness: "unclaimed",
          },
          null,
          2,
        ) + "\n";
      const total = outputs.reduce(
        (sum, output) =>
          sum + Buffer.byteLength(output.content) + Buffer.byteLength(receiptContent(output)),
        0,
      );
      if (total > HISTORICAL_LIMITS.outputBytes) throw historicalFailure();
      let written = 0,
        existing = 0;
      const capacity =
        mode === "apply"
          ? await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
              courses: inventory.roots
                .filter((root) => root.courseKey)
                .map((root) => ({ destination: root.path })),
            })
          : null;
      for (const output of outputs) {
        reads.active();
        for (const input of inventory.inputs) {
          if (input.path === output.sourcePath || input.path === output.originalPath) {
            if ((await reads.read(input.path)).sha256 !== input.sha256) throw historicalFailure();
          }
        }
        if (mode === "verify") {
          if ((await reads.read(output.path)).sha256 !== historicalDigest(output.content))
            throw historicalFailure();
          if (
            (await reads.read(output.path + ".receipt.json")).sha256 !==
            historicalDigest(receiptContent(output))
          )
            throw historicalFailure();
        } else {
          const status = await publishHistoricalFile(output.path, Buffer.from(output.content), {
            reads,
            boundary: output.boundary,
            checkCapacity: capacity.check,
            expectedSha256: historicalDigest(output.content),
          });
          if (status === "written") written++;
          else existing++;
          const body = receiptContent(output);
          await publishHistoricalFile(output.path + ".receipt.json", Buffer.from(body), {
            reads,
            boundary: output.boundary,
            checkCapacity: capacity.check,
            expectedSha256: historicalDigest(body),
          });
        }
        await dependencies.afterOutput?.({ written, existing, output });
      }
      for (const input of inventory.inputs)
        if ((await reads.read(input.path)).sha256 !== input.sha256) throw historicalFailure();
      return result(mode, inventory, {
        manifestPath,
        written,
        existing,
        outputs: outputs.length,
        sourcesUnchanged: true,
      });
    };
    return mode === "apply"
      ? await (dependencies.lock ?? withMediaQueueLock)({
          statePath: config.statePath,
          run: execute,
        })
      : await execute();
  } catch {
    return capabilityResult(
      `media:format:${mode}`,
      [
        observation(
          "execution",
          "failed",
          "HISTORICAL_FORMAT_FAILED",
          "Historical formatting stopped; partial exclusive editions and receipts may remain. No original was replaced.",
          ACTION,
        ),
      ],
      { acousticQuality: "unrun", sourceCorrection: "none", physicalIoCancellation: "unclaimed" },
    );
  }
}

function manifestOf(inventory) {
  return {
    ...inventory,
    editions: inventory.editions.map(({ markdown: _markdown, ...edition }) => edition),
  };
}

function result(mode, inventory, extra) {
  return capabilityResult(
    `media:format:${mode}`,
    [
      observation(
        "formatting",
        "passed",
        "HISTORICAL_FORMAT_" + mode.toUpperCase(),
        "Historical inventory and lexical formatting evidence retained. Media readiness and source correctness remain separate.",
      ),
    ],
    {
      ...extra,
      planId: inventory.id,
      policy: inventory.policy,
      courses: inventory.roots.filter((root) => root.courseKey).length,
      sources: inventory.sources.length,
      nativeSources: inventory.sources.filter((source) => source.kind === "native").length,
      rawSources: inventory.sources.filter((source) => source.kind === "raw").length,
      derivatives: inventory.derivatives.length,
      associated: inventory.editions.length,
      eligible: inventory.editions.filter((edition) => edition.eligible).length,
      unassociatedDerivatives: inventory.derivatives.filter(
        (derivative) => derivative.association !== "proven",
      ).length,
      unassociatedSources: inventory.sources.filter(
        (source) => source.kind === "raw" && source.association !== "proven",
      ).length,
      sourceFlags: inventory.sources.filter((source) => source.flags.length).length,
      timingFailures: inventory.sources.filter((source) => source.timing === "failed").length,
      timingUnknown: inventory.sources.filter(
        (source) => source.kind === "raw" && source.timing === "unknown-duration",
      ).length,
      lexicalFailures: inventory.editions.filter((edition) => edition.lexical === "failed").length,
      acousticQuality: "unrun",
      sourceCorrection: "none",
      mediaReadiness: "unclaimed",
      physicalIoCancellation: "unclaimed",
    },
  );
}

function plannedOutputs(inventory) {
  const outputs = [];
  const folder = `${HISTORICAL_FORMAT_VERSION}-${inventory.id}`;
  const current = inventory.editions.filter((edition) => edition.eligible);
  for (const edition of current) {
    const path = join(
      edition.coursePath,
      "Transcript editions",
      folder,
      `recording-${historicalDigest(edition.recordingId).slice(0, 24)}.md`,
    );
    edition.editionPath = path;
    outputs.push({ ...edition, path, boundary: edition.coursePath, content: edition.markdown });
    const provenance = {
      schemaVersion: 1,
      policy: inventory.policy,
      recordingId: edition.recordingId,
      sourcePath: edition.sourcePath,
      sourceSha256: edition.sourceSha256,
      originalPath: edition.originalPath,
      originalSha256: edition.originalSha256,
      editionSha256: edition.editionSha256,
      sourceFlags: edition.sourceFlags,
      timing: edition.timing,
      mediaReadiness: "unclaimed",
    };
    outputs.push({
      ...edition,
      path: path + ".provenance.json",
      boundary: edition.coursePath,
      content: JSON.stringify(provenance, null, 2) + "\n",
    });
  }
  const link = (label, path) =>
    path
      ? `[${label.replaceAll("[", "_").replaceAll("]", "_").replaceAll("\\", "_")}](${pathToFileURL(path).href})`
      : "unavailable";
  for (const root of inventory.roots.filter((root) => root.courseKey)) {
    const entries = inventory.editions.filter((edition) => edition.courseKey === root.courseKey);
    const unresolved = inventory.derivatives.filter(
      (derivative) =>
        insideHistoricalRoot(root.path, derivative.path) && derivative.association !== "proven",
    );
    const lines = [
      "# Transcript editions",
      "",
      "Current paragraph editions preserve source wording. Timing failures and suspected source corruption remain visible; formatting proves neither source correctness nor media readiness.",
      "",
      ...entries.flatMap((edition) => [
        `- ${link(edition.eligible ? "Open paragraph edition" : "No edition: inspect source", edition.editionPath)} — ${link(basename(edition.originalPath), edition.originalPath)}`,
        `  Source: ${link("raw transcript", edition.sourcePath)}; ${link("original provenance", edition.metadataPath)}; ${link("edition provenance", edition.editionPath ? edition.editionPath + ".provenance.json" : null)}; status: ${link("media status", edition.statusPath)}. Timing: ${edition.timing}. Source flags: ${edition.sourceFlags.join(", ") || "none"}.`,
      ]),
      ...unresolved.map(
        (derivative) =>
          `- Unassociated or edited: ${link(basename(derivative.path), derivative.path)}. Inspect source/recording/placement evidence; original retained.`,
      ),
      "",
    ];
    outputs.push({
      path: join(root.path, "Transcript editions", folder, "index.md"),
      boundary: root.path,
      content: lines.join("\n"),
    });
  }
  return outputs;
}
