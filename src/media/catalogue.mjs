import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { capabilityResult, observation } from "../capabilities/result.mjs";
import {
  catalogueReads,
  catalogueJson,
  catalogueFailure,
  scanCatalogue,
  CATALOGUE_POLICY,
} from "./catalogue-files.mjs";
import {
  catalogueProfileBinding,
  assertCatalogueProfile,
  assertCataloguePrivatePath,
} from "./catalogue-profile.mjs";
import { catalogueInventory } from "./catalogue-inventory.mjs";
import {
  catalogueTarget,
  publishCatalogueTarget,
  verifyCatalogueTarget,
} from "./catalogue-publication.mjs";
import {
  historicalDigest,
  publishHistoricalFile,
  insideHistoricalRoot,
  HISTORICAL_LIMITS,
} from "./historical-files.mjs";
import { recoveryFile, assertRecoveryFileIdentity } from "./recovery-files.mjs";
import { assertRecoveryAbsences } from "./recovery-authority.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { readMediaQueue } from "./queue.mjs";
import { assertMediaSafetyAdmission } from "./safety.mjs";

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const ACTION =
  "Inspect retained private catalogue plan/journal and current ownership; retry the same unchanged plan after interruption, or create a fresh plan after input changes. Originals remain.";

export async function transcriptCatalogue(
  { mode, config, manifestPath, selectionPath, signal },
  dependencies = {},
) {
  const progress = { written: 0, existing: 0, promoted: 0, publication: "unrun" };
  try {
    if (
      !["inspect", "plan", "publish", "verify"].includes(mode) ||
      (mode !== "inspect" && !manifestPath) ||
      (selectionPath && mode !== "plan")
    )
      throw catalogueFailure("CATALOGUE_ARGUMENTS");
    const reads = catalogueReads(signal);
    const profileBinding = await catalogueProfileBinding(config.profilePath);
    await assertCatalogueProfile(profileBinding, [
      ...config.courses.map((course) => course.destination),
      config.media.mediaRoot,
    ]);
    for (const privatePath of [
      manifestPath,
      manifestPath && manifestPath + ".catalogue-plan.json",
      selectionPath,
    ].filter(Boolean))
      await assertCataloguePrivatePath(profileBinding, resolve(privatePath));
    const readPrivate = async (privatePath) => {
      await assertCataloguePrivatePath(profileBinding, privatePath);
      return reads.read(privatePath);
    };
    if (mode === "inspect") {
      const inventory = await catalogueInventory({ config, reads, signal, profileBinding });
      await assertSnapshot(inventory, signal);
      reads.active();
      return {
        schemaVersion: 1,
        command: "media:catalogue:inspect",
        status: "passed",
        exitCode: 0,
        catalogue: publicInventory(inventory),
      };
    }
    const path = resolve(manifestPath);
    if (mode === "plan") {
      const selection = selectionPath
        ? catalogueJson(await readPrivate(resolve(selectionPath)))
        : [];
      const inventory = await catalogueInventory({
        config,
        reads,
        signal,
        selections: selection,
        profileBinding,
      });
      const targets = [];
      for (const course of inventory.courses)
        targets.push(
          await catalogueTarget(course, catalogueMarkdown(course, inventory.unassociated), reads),
        );
      const body = {
        schemaVersion: 1,
        policy: CATALOGUE_POLICY,
        selections: selection,
        inventory,
        targets,
      };
      const manifest = { ...body, id: historicalDigest(JSON.stringify(body)).slice(0, 24) };
      const parent = await reads.probe(() => realpath(dirname(path)));
      if (
        parent !== dirname(path) ||
        path === config.statePath ||
        (config.profilePath &&
          (path === config.profilePath || insideHistoricalRoot(config.profilePath, path))) ||
        inventory.bindings.some(
          (binding) => path === binding.canonical || insideHistoricalRoot(binding.canonical, path),
        )
      )
        throw catalogueFailure("CATALOGUE_MANIFEST_PATH");
      const content = json(manifest);
      if (Buffer.byteLength(content) > HISTORICAL_LIMITS.fileBytes)
        throw catalogueFailure("CATALOGUE_LIMIT");
      await assertSnapshot(inventory, signal);
      await assertCataloguePrivatePath(profileBinding, path);
      await publishHistoricalFile(path, Buffer.from(content), {
        reads,
        boundary: parent,
        expectedSha256: historicalDigest(content),
      });
      const proof = json({
        schemaVersion: 1,
        policy: CATALOGUE_POLICY,
        path,
        planId: manifest.id,
        sha256: historicalDigest(content),
      });
      await assertCataloguePrivatePath(profileBinding, path + ".catalogue-plan.json");
      await publishHistoricalFile(path + ".catalogue-plan.json", Buffer.from(proof), {
        reads,
        boundary: parent,
        expectedSha256: historicalDigest(proof),
      });
      return result(mode, inventory, { planId: manifest.id });
    }
    const retained = await readPrivate(path),
      manifest = catalogueJson(retained),
      { id, ...body } = manifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.policy !== CATALOGUE_POLICY ||
      id !== historicalDigest(JSON.stringify(body)).slice(0, 24)
    )
      throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
    const planReceipt = await readPrivate(path + ".catalogue-plan.json");
    if (
      planReceipt.content.toString("utf8") !==
      json({
        schemaVersion: 1,
        policy: CATALOGUE_POLICY,
        path,
        planId: id,
        sha256: retained.sha256,
      })
    )
      throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
    const execute = async () => {
      const inventory = await catalogueInventory({
        config,
        reads,
        signal,
        selections: manifest.selections,
        profileBinding,
      });
      if (
        JSON.stringify(inventory) !== JSON.stringify(manifest.inventory) ||
        manifest.targets.length !== inventory.courses.length
      )
        throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
      for (const [index, course] of inventory.courses.entries()) {
        const target = manifest.targets[index],
          content = catalogueMarkdown(course, inventory.unassociated);
        if (
          target.path !== resolve(course.path, "Transcript editions/index.md") ||
          target.boundary !== course.path ||
          target.content !== content ||
          target.sha256 !== historicalDigest(content)
        )
          throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
      }
      const capacity =
        mode === "publish"
          ? await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
              courses: inventory.courses.map((course) => ({ destination: course.path })),
            })
          : null;
      const check = async (includeMedia = false) => {
        reads.active();
        await capacity?.check({ boundary: config.media.mediaRoot });
        await assertSnapshot(inventory, signal, { includeMedia: includeMedia === true });
        if ((await readPrivate(path + ".catalogue-plan.json")).sha256 !== planReceipt.sha256)
          throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
        if ((await readPrivate(path)).sha256 !== retained.sha256)
          throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
      };
      await check(true);
      for (const target of manifest.targets) {
        if (mode === "verify") await verifyCatalogueTarget({ target, planId: id, reads });
        else
          await publishCatalogueTarget({
            target,
            planId: id,
            reads,
            check,
            checkCapacity: async (request) => {
              await check();
              await capacity.check(request);
              await check();
            },
            progress,
            afterOutput: dependencies.afterOutput,
          });
      }
      await check(true);
      progress.publication = mode === "publish" ? "published" : "verified";
      return result(mode, inventory, { planId: id, ...progress });
    };
    if (mode === "publish")
      return await (dependencies.lock ?? withMediaQueueLock)({
        statePath: config.statePath,
        run: async () => {
          await (dependencies.admission ?? assertMediaSafetyAdmission)({
            statePath: config.statePath,
            courses: config.courses,
            readQueue: readMediaQueue,
          });
          return execute();
        },
      });
    return await execute();
  } catch (error) {
    const code = /^CATALOGUE_[A-Z_]+$|^MEDIA_[A-Z_]+$/.test(error.code ?? "")
      ? error.code
      : signal?.aborted
        ? "CATALOGUE_INTERRUPTED"
        : "CATALOGUE_EVIDENCE_INVALID";
    return capabilityResult(
      `media:catalogue:${mode}`,
      [
        observation(
          "catalogue",
          code === "CATALOGUE_ARGUMENTS" || code.startsWith("MEDIA_") ? "blocked" : "failed",
          code,
          "Catalogue stopped; retained files and journal remain. No raw exception exposed.",
          ACTION,
        ),
      ],
      {
        ...progress,
        partialPublication:
          progress.written || progress.promoted ? "retained-managed-publication" : "none",
        acousticVerification: "unrun",
        mediaReadiness: "unclaimed",
        physicalIoCancellation: "unclaimed",
      },
    );
  }
}

async function assertSnapshot(inventory, signal, { includeMedia = false } = {}) {
  signal?.throwIfAborted();
  await assertCatalogueProfile(
    inventory.profileBinding,
    inventory.bindings.map((binding) => binding.logical),
  );
  await assertRecoveryAbsences(inventory.absences, signal);
  for (const binding of inventory.bindings)
    if ((await realpath(binding.logical)) !== binding.canonical)
      throw catalogueFailure("CATALOGUE_PARENT_CHANGED");
  for (const input of inventory.inputs) {
    const media = inventory.mediaIdentities.find((pin) => pin.path === input.path);
    if (media) {
      await assertRecoveryFileIdentity(media, signal);
      if (!includeMedia) continue;
    }
    const current = await recoveryFile(input.path, {
      maximumBytes: input.bytes,
      signal,
      retain: false,
    });
    if (current.sha256 !== input.sha256 || current.bytes !== input.bytes)
      throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
  }
  const scanned = [];
  const scanReads = catalogueReads(signal);
  for (const binding of inventory.bindings)
    scanned.push(...(await scanCatalogue(binding.canonical, scanReads)));
  if (JSON.stringify(scanned.sort()) !== JSON.stringify(inventory.scannedPaths))
    throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
  await assertRecoveryAbsences(inventory.absences, signal);
}
function publicInventory({
  inputs: _inputs,
  absences: _absences,
  bindings: _bindings,
  scannedPaths: _scannedPaths,
  mediaIdentities: _mediaIdentities,
  profileBinding: _profileBinding,
  ...inventory
}) {
  return inventory;
}
function result(mode, inventory, extra) {
  const recordings = inventory.courses.flatMap((course) => course.recordings);
  return capabilityResult(
    `media:catalogue:${mode}`,
    [
      observation(
        "catalogue",
        "passed",
        "CATALOGUE_" + mode.toUpperCase(),
        "Verified reading editions remain separate from canonical source review and media readiness.",
      ),
    ],
    {
      courses: inventory.courses.length,
      recordings: recordings.length,
      appearances: inventory.courses.reduce((sum, course) => sum + course.counts.appearances, 0),
      unresolved: inventory.courses.reduce((sum, course) => sum + course.unresolved.length, 0),
      nonRecordings: inventory.courses.reduce(
        (sum, course) => sum + course.nonRecordings.length,
        0,
      ),
      preferred: recordings.filter((record) => record.preferred).length,
      review: recordings.filter((record) => record.reading === "review").length,
      incomplete: recordings.filter((record) => record.reading === "incomplete").length,
      unassociated: inventory.unassociated.length,
      acousticVerification: "unrun",
      mediaReadiness: "unclaimed",
      ...extra,
    },
  );
}
const escape = (value) =>
  String(value)
    .replace(/[\r\n]/g, " ")
    .replace(/[\\`*_[\]<>]/g, "\\$&");
const link = (label, path) => `[${escape(label)}](<${pathToFileURL(path).href}>)`;
export function catalogueMarkdown(course, unassociated) {
  const lines = [
    `# ${escape(course.key)} transcripts`,
    "",
    `Upstream course: [NTULearn](${course.courseUrl})`,
    "",
    "Reading verification is lexical/provenance evidence. Acoustic verification unrun. Canonical source review and media readiness remain separate.",
    "",
  ];
  lines.push(
    `Accounted appearances: ${course.counts.appearances}; recognized recordings: ${course.counts.recordings}; unresolved review: ${course.counts.unresolved}; non-recordings: ${course.counts.nonRecordings}.`,
    "",
    "## Recognized recordings",
    "",
  );
  for (const record of course.recordings) {
    lines.push(
      `### ${escape(record.title)}`,
      "",
      `Reading: ${record.reading}${record.reason ? ` (${escape(record.reason)})` : ""}. Media: ${escape(record.media.stage)} / ${escape(record.media.verdict)}; complete: ${record.media.complete}.`,
      `Original source flags: ${record.sourceReview.flags.map(escape).join(", ") || "none observed"}; timing: ${escape(record.sourceReview.timing)}; acoustic: unrun.`,
      `Stable source reference: ${escape(record.sourceReference)}`,
      "",
    );
    if (record.preferred)
      lines.push(
        `${link("Preferred reading edition", record.preferred.path)} (${record.preferred.kind}; timing: ${escape(record.preferred.timing)})`,
        "",
      );
    lines.push(
      [
        record.original
          ? link("Original derivative", record.original)
          : "Original derivative absent or unproven",
        record.source ? link("Original raw source", record.source) : "Original raw source unproven",
        record.mediaPath ? link("Retained media", record.mediaPath) : "Retained media unproven",
        record.statusPath
          ? link("Current media status", record.statusPath)
          : "Current media status unavailable",
      ].join(" · "),
      "",
    );
    for (const edition of record.editions)
      lines.push(
        `- ${link("Retained " + edition.kind + " edition", edition.path)}: ${edition.reading}${edition.reason ? ` (${escape(edition.reason)})` : ""}${edition.provenance ? ` · ${link("Provenance", edition.provenance)}` : ""}`,
      );
    lines.push("");
  }
  lines.push("## Unresolved appearances — review", "");
  for (const record of course.unresolved)
    lines.push(
      `- ${escape(record.title)}: ${escape(record.disposition)}; ${escape(record.classificationEvidence)}; source reference: ${escape(record.sourceReference)}`,
    );
  lines.push(
    "",
    "## Non-recording appearances",
    "",
    `${course.nonRecordings.length} positively classified non-recording appearance(s); no transcript completeness claimed.`,
    "",
  );
  lines.push(
    "## Unassociated evidence",
    "",
    `${unassociated.length} retained item(s) accounted for globally; none assigned to this course without positive ownership. Use media:catalogue inspect for private details.`,
    "",
  );
  return lines.join("\n");
}
