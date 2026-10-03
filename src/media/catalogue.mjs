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
import { assertCatalogueBindings } from "./catalogue-course.mjs";
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
import { GLOBAL_MEDIA_ERROR_CODES } from "./errors.mjs";
import { readMediaQueue } from "./queue.mjs";
import { assertMediaSafetyAdmission, persistMediaSafetyBarrier } from "./safety.mjs";

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const ACTION =
  "Inspect retained private catalogue plan/journal and current ownership; retry the same unchanged plan after interruption, or create a fresh plan after input changes. Originals remain.";

export async function transcriptCatalogue(
  { mode, config, manifestPath, selectionPath, signal },
  dependencies = {},
) {
  const progress = {
    written: 0,
    existing: 0,
    promoted: 0,
    publication: "unrun",
    stage: "arguments",
    snapshotChecks: 0,
    snapshotInputChecks: 0,
    snapshotScans: 0,
  };
  let reads;
  try {
    if (
      !["inspect", "plan", "publish", "verify"].includes(mode) ||
      (mode !== "inspect" && !manifestPath) ||
      (selectionPath && mode !== "plan")
    )
      throw catalogueFailure("CATALOGUE_ARGUMENTS");
    reads = catalogueReads(signal, {
      now: dependencies.now,
      ...(dependencies.mediaReads ? { media: dependencies.mediaReads } : {}),
    });
    progress.stage = "profile";
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
    const readPrivate = async (privatePath, options) => {
      await assertCataloguePrivatePath(profileBinding, privatePath);
      return reads.read(privatePath, options);
    };
    if (mode === "inspect") {
      progress.stage = "inventory";
      const inventory = await catalogueInventory({ config, reads, signal, profileBinding });
      progress.stage = "snapshot";
      await assertSnapshot(inventory, signal, { mediaReads: reads.media, diagnostics: progress });
      reads.active();
      return {
        schemaVersion: 1,
        command: "media:catalogue:inspect",
        status: "passed",
        exitCode: 0,
        catalogue: publicInventory(inventory),
        evidence: { reads: reads.evidence() },
      };
    }
    const path = resolve(manifestPath);
    if (mode === "plan") {
      progress.stage = "selection-read";
      const selection = selectionPath
        ? catalogueJson(await readPrivate(resolve(selectionPath)))
        : [];
      progress.stage = "inventory";
      const inventory = await catalogueInventory({
        config,
        reads,
        signal,
        selections: selection,
        profileBinding,
      });
      progress.stage = "plan-targets";
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
      progress.stage = "plan-validation";
      const content = JSON.stringify(manifest) + "\n";
      if (Buffer.byteLength(content) > HISTORICAL_LIMITS.fileBytes)
        throw catalogueFailure("CATALOGUE_LIMIT", {
          kind: "plan-bytes",
          observed: Buffer.byteLength(content),
          maximum: HISTORICAL_LIMITS.fileBytes,
        });
      catalogueJson({ content: Buffer.from(content) });
      const proof = json({
        schemaVersion: 1,
        policy: CATALOGUE_POLICY,
        path,
        planId: manifest.id,
        sha256: historicalDigest(content),
      });
      catalogueJson({ content: Buffer.from(proof) });
      progress.stage = "snapshot";
      await assertSnapshot(inventory, signal, { mediaReads: reads.media, diagnostics: progress });
      await assertCataloguePrivatePath(profileBinding, path);
      progress.stage = "plan-write";
      await publishHistoricalFile(path, Buffer.from(content), {
        reads,
        boundary: parent,
        expectedSha256: historicalDigest(content),
      });
      await assertCataloguePrivatePath(profileBinding, path + ".catalogue-plan.json");
      await publishHistoricalFile(path + ".catalogue-plan.json", Buffer.from(proof), {
        reads,
        boundary: parent,
        expectedSha256: historicalDigest(proof),
      });
      return result(mode, inventory, { planId: manifest.id, reads: reads.evidence() });
    }
    progress.stage = "manifest-read";
    const retained = await readPrivate(path, { includeIdentity: true }),
      manifest = catalogueJson(retained),
      { id, ...body } = manifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.policy !== CATALOGUE_POLICY ||
      id !== historicalDigest(JSON.stringify(body)).slice(0, 24)
    )
      throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
    progress.stage = "manifest-read";
    const planReceipt = await readPrivate(path + ".catalogue-plan.json", { includeIdentity: true });
    progress.stage = "manifest-validation";
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
      progress.stage = "inventory";
      const inventory = await catalogueInventory({
        config,
        reads,
        signal,
        selections: manifest.selections,
        profileBinding,
      });
      progress.stage = "manifest-validation";
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
      progress.stage = "capacity";
      const capacity =
        mode === "publish"
          ? await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
              courses: inventory.courses.map((course) => ({ destination: course.path })),
            })
          : null;
      const check = async (includeMedia = false) => {
        const priorStage = progress.stage;
        progress.stage = "snapshot";
        reads.active();
        progress.stage = "capacity";
        await capacity?.check({ boundary: config.media.mediaRoot });
        progress.stage = "snapshot";
        await assertSnapshot(inventory, signal, {
          includeMedia: includeMedia === true,
          mediaReads: reads.media,
          diagnostics: progress,
        });
        for (const pin of [planReceipt, retained]) {
          await assertCataloguePrivatePath(profileBinding, pin.path);
          try {
            await assertRecoveryFileIdentity(pin, signal);
            if (includeMedia && (await readPrivate(pin.path)).sha256 !== pin.sha256)
              throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
            await assertRecoveryFileIdentity(pin, signal);
          } catch (error) {
            if (error.code === "HISTORICAL_READ_LIMIT" || signal?.aborted) throw error;
            throw catalogueFailure("CATALOGUE_MANIFEST_CHANGED");
          }
        }
        progress.stage = priorStage;
      };
      await check(true);
      progress.stage = mode === "verify" ? "verify" : "publication";
      for (const target of manifest.targets) {
        if (mode === "verify") await verifyCatalogueTarget({ target, planId: id, reads });
        else
          await publishCatalogueTarget({
            target,
            planId: id,
            reads,
            check,
            signal,
            checkExisting: async (request) => {
              await assertCataloguePrivatePath(profileBinding, request.path);
              await capacity.check(request);
              await assertCataloguePrivatePath(profileBinding, request.path);
            },
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
      progress.stage = "complete";
      progress.publication = mode === "publish" ? "published" : "verified";
      return result(mode, inventory, { planId: id, ...progress, reads: reads.evidence() });
    };
    if (mode === "publish") {
      progress.stage = "lock";
      return await (dependencies.lock ?? withMediaQueueLock)({
        statePath: config.statePath,
        run: async () => {
          progress.stage = "admission";
          await (dependencies.admission ?? assertMediaSafetyAdmission)({
            statePath: config.statePath,
            courses: config.courses,
            readQueue: readMediaQueue,
          });
          try {
            return await execute();
          } catch (error) {
            await persistMediaSafetyBarrier({ statePath: config.statePath, error });
            throw error;
          }
        },
      });
    }
    return await execute();
  } catch (caught) {
    let error = caught;
    try {
      await persistMediaSafetyBarrier({ statePath: config?.statePath, error });
    } catch (barrierFailure) {
      error = barrierFailure;
    }
    const code =
      error.code === "HISTORICAL_READ_LIMIT"
        ? "CATALOGUE_LIMIT"
        : /^CATALOGUE_[A-Z_]+$|^MEDIA_[A-Z_]+$/.test(error.code ?? "") ||
            GLOBAL_MEDIA_ERROR_CODES.includes(error.code)
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
          error.code === "MEDIA_FILE_CLEANUP" || error.code === "MEDIA_SAFETY_BARRIER_WRITE"
            ? "Retain containment and the safety barrier; Owner must confirm pending file I/O and descriptor closure before explicitly clearing safety evidence. Do not retry automatically."
            : code === "CATALOGUE_LIMIT"
              ? "Inspect the fixed stage, limit kind and numeric counters in retained evidence; confirm responsive storage and bounded unchanged inputs before explicitly retrying the same plan. Originals and journals remain."
              : ACTION,
        ),
      ],
      {
        ...progress,
        ...(publicLimit(error.limit) ? { limit: publicLimit(error.limit) } : {}),
        partialPublication:
          progress.written || progress.promoted ? "retained-managed-publication" : "none",
        acousticVerification: "unrun",
        mediaReadiness: "unclaimed",
        physicalIoCancellation: "unclaimed",
        ...(error.code === "MEDIA_FILE_CLEANUP" || error.code === "MEDIA_SAFETY_BARRIER_WRITE"
          ? {
              cleanup: "unconfirmed",
              safetyBarrier:
                error.code === "MEDIA_FILE_CLEANUP"
                  ? "retained"
                  : "write-failed-external-containment-required",
            }
          : {}),
        ...(reads ? { reads: reads.evidence() } : {}),
      },
    );
  }
}

async function assertSnapshot(
  inventory,
  signal,
  { includeMedia = false, mediaReads, diagnostics } = {},
) {
  if (diagnostics) diagnostics.snapshotChecks++;
  signal?.throwIfAborted();
  await assertCatalogueBindings(inventory.bindings, {
    media: mediaReads,
    profileBinding: inventory.profileBinding,
  });
  await assertRecoveryAbsences(inventory.absences, signal);
  for (const input of inventory.inputs) {
    const media = inventory.mediaIdentities.find((pin) => pin.path === input.path);
    if (media) {
      await mediaReads.assertIdentity(media);
      if (!includeMedia) {
        if (diagnostics) diagnostics.snapshotInputChecks++;
        continue;
      }
      const current = await mediaReads.read(
        input.path,
        media.boundary ??
          inventory.bindings.find((binding) => insideHistoricalRoot(binding.canonical, input.path))
            .canonical,
      );
      if (current.sha256 !== input.sha256 || current.bytes !== input.bytes)
        throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
      if (diagnostics) diagnostics.snapshotInputChecks++;
      continue;
    }
    const current = await recoveryFile(input.path, {
      maximumBytes: input.bytes,
      signal,
      retain: false,
    });
    if (current.sha256 !== input.sha256 || current.bytes !== input.bytes)
      throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
    if (diagnostics) diagnostics.snapshotInputChecks++;
  }
  const scanned = [];
  const scanReads = catalogueReads(signal);
  for (const root of new Set(inventory.bindings.map((binding) => binding.canonical))) {
    scanned.push(...(await scanCatalogue(root, scanReads)));
    if (diagnostics) diagnostics.snapshotScans++;
  }
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
      retainedMediaAccess: recordings.filter((record) => record.mediaAccess?.status === "verified")
        .length,
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
      `Retained media access: ${escape(record.mediaAccess?.status ?? "unproven")}; recording completeness: unclaimed by access; acoustic verification: unrun.`,
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
        record.mediaAccess?.status === "verified" && record.mediaPath
          ? link("Retained media", record.mediaPath)
          : "Retained media unproven",
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

function publicLimit(limit) {
  if (
    !limit ||
    ![
      "elapsed-ms",
      "file-bytes",
      "read-bytes",
      "scan-depth",
      "scan-entries",
      "plan-bytes",
    ].includes(limit.kind) ||
    !Number.isSafeInteger(limit.observed) ||
    limit.observed < 0 ||
    !Number.isSafeInteger(limit.maximum) ||
    limit.maximum <= 0
  )
    return null;
  return { kind: limit.kind, observed: limit.observed, maximum: limit.maximum };
}
