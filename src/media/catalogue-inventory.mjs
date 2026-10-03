import { dirname, basename, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { assertCatalogueProfile } from "./catalogue-profile.mjs";
import { catalogueRetainedMedia } from "./catalogue-media.mjs";
import { historicalInventory } from "./historical-inventory.mjs";
import { historicalDigest, insideHistoricalRoot } from "./historical-files.mjs";
import { readMediaQueue } from "./queue.mjs";
import { mediaRecordingRoot } from "./storage.mjs";
import { mediaRecordingStatus } from "./status.mjs";
import { validateSourceReviewFlags } from "./source-paragraphs.mjs";
import { publicMediaError, isGlobalMediaSafetyFailure } from "./errors.mjs";
import { courseUrl } from "../ntulearn/urls.mjs";
import { pinRecoveryAbsence } from "./recovery-authority.mjs";
import {
  catalogueParagraph,
  catalogueRecovery,
  preferredCatalogueEdition,
} from "./catalogue-editions.mjs";
import {
  scanCatalogue,
  catalogueJson,
  catalogueFingerprint,
  CATALOGUE_POLICY,
  catalogueFailure,
} from "./catalogue-files.mjs";

export async function catalogueInventory({
  config,
  reads,
  signal,
  selections = [],
  profileBinding = null,
}) {
  await assertCatalogueProfile(profileBinding, [
    ...config.courses.map((course) => course.destination),
    config.media.mediaRoot,
  ]);
  const historical = await historicalInventory({
    config,
    signal,
    reads: { ...reads, read: (path) => reads.file(path) },
  });
  const courses = historical.roots
    .filter((root) => root.courseKey)
    .map((root) => ({
      key: root.courseKey,
      path: root.path,
      courseId: root.courseId,
      courseUrl: courseUrl(encodeURIComponent(root.courseId)),
      recordings: [],
      unresolved: [],
      nonRecordings: [],
    }));
  const claims = [],
    reports = [],
    paths = [],
    unassociated = [];
  for (const course of config.courses) {
    const loaded = await readMediaQueue({
      statePath: config.statePath,
      courseKey: course.key,
      course,
      read: async (path) => {
        const file = await reads.optional(path);
        if (file) return file.content;
        const absence = await pinRecoveryAbsence(path, {
          declared: { path, absent: true },
          manifestPath: path,
          signal,
        });
        reads.absences.set(path, absence);
        throw Object.assign(new Error("Absent"), { code: "ENOENT" });
      },
    });
    for (const job of loaded.record?.queue ?? [])
      claims.push({ job, course: courses.find((item) => item.key === course.key) });
  }
  for (const root of historical.roots) paths.push(...(await scanCatalogue(root.path, reads)));
  for (const path of paths.filter((path) => path.endsWith("/recovery.json"))) {
    try {
      reports.push({ report: catalogueJson(await reads.file(path)), directory: dirname(path) });
    } catch {
      unassociated.push({ path, kind: "recovery-evidence", reason: "invalid-evidence" });
    }
  }
  const selected = new Map();
  if (!Array.isArray(selections) || selections.length > 20000)
    throw catalogueFailure("CATALOGUE_SELECTION_INVALID");
  for (const selection of selections) {
    if (
      !selection ||
      typeof selection.recordingId !== "string" ||
      !/^[0-9a-f]{64}$/.test(selection.sha256 ?? "") ||
      selected.has(selection.recordingId)
    )
      throw catalogueFailure("CATALOGUE_SELECTION_INVALID");
    selected.set(selection.recordingId, selection.sha256);
  }
  const retainedMedia = await catalogueRetainedMedia({
    claims,
    courses,
    config,
    store: historical.roots.find((root) => !root.courseKey).path,
    reads,
    profileBinding,
  });
  const mediaIdentities = retainedMedia.identities;
  const usedPaths = new Set(),
    records = new Map();
  for (const { course, job } of claims) {
    const display = mediaRecordingStatus({ appearance: job, job });
    const id = job.recordingId;
    const unique = claims.filter((claim) => claim.job.recordingId === id).length === 1;
    const record = {
      recordingId: id,
      disposition: display.disposition,
      classificationEvidence: publicMediaError(display.classificationEvidence).slice(0, 500),
      title: publicMediaError(display.title).slice(0, 500),
      sourceReference: publicMediaError(display.sourceReference ?? "unavailable").slice(0, 500),
      source: null,
      original: null,
      statusPath: null,
      editions: [],
      preferred: null,
      mediaAccess: retainedMedia.proofs.get(id)?.access ?? {
        status: "unproven",
        reason: "ownership-unproven",
        acousticVerification: "unrun",
        completeness: "unclaimed",
      },
      ...(retainedMedia.proofs.get(id)?.access.status === "verified"
        ? { mediaPath: retainedMedia.proofs.get(id).access.path }
        : {}),
      reading: "incomplete",
      reason: unique ? "edition-incomplete" : "ambiguous-association",
      sourceReview: {
        flags: display.transcript.flags?.length
          ? display.transcript.flags
          : display.transcript.reviewRequired
            ? ["review-required"]
            : [],
        timing: "unknown",
        acousticVerification: "unrun",
      },
      media: {
        stage: display.stage,
        verdict: display.verdict,
        complete: display.complete === true,
      },
    };
    if (display.disposition !== "recording") {
      record.reading = display.disposition === "unresolved" ? "review" : "excluded";
      record.reason =
        display.disposition === "unresolved" ? "unresolved-classification" : "non-recording";
      course[display.disposition === "unresolved" ? "unresolved" : "nonRecordings"].push(record);
      continue;
    }
    course.recordings.push(record);
    if (!unique) {
      record.reading = "review";
      continue;
    }
    records.set(id, record);
    const root = mediaRecordingRoot(historical.roots.find((root) => !root.courseKey).path, id),
      raw = join(root, "transcript.raw.json");
    const source = historical.sources.find((item) => item.path === raw);
    if (source) {
      record.sourceReview = {
        flags: [...new Set([...record.sourceReview.flags, ...source.flags])],
        timing: source.timing,
        acousticVerification: "unrun",
      };
      if (source.flags.length || !source.valid) record.reading = "review";
    }
    for (const [name, flagField] of [
      ["transcript.state.json", "transcript"],
      ["transcript.metadata.json", "sourceReview"],
    ]) {
      const file = reads.files.get(join(root, name));
      if (!file?.content) continue;
      const evidence = catalogueJson(file);
      if (evidence.recordingId !== id) continue;
      const flags = flagField === "transcript" ? evidence.transcript?.flags : evidence.sourceReview;
      if (
        flags !== undefined ||
        (flagField === "transcript" && evidence.transcript?.reviewRequired)
      ) {
        const retained = validateSourceReviewFlags(flags, {
          required: flagField === "transcript" && evidence.transcript?.reviewRequired === true,
        });
        record.sourceReview.flags = [...new Set([...record.sourceReview.flags, ...retained])];
      }
    }
    const item = historical.editions.find(
      (edition) => edition.recordingId === id && edition.courseKey === course.key,
    );
    if (item) {
      record.source = item.sourcePath;
      record.original = item.originalPath;
      record.statusPath = item.statusPath;
      usedPaths.add(item.sourcePath);
      usedPaths.add(item.originalPath);
      if (item.eligible)
        for (const path of paths.filter(
          (path) =>
            insideHistoricalRoot(course.path, path) &&
            /\/source-paragraphs-v1-[0-9a-f]{24}\/recording-[0-9a-f]{24}\.md$/.test(path),
        )) {
          const name = `recording-${historicalDigest(id).slice(0, 24)}.md`;
          if (!path.endsWith("/" + name)) continue;
          try {
            const edition = await catalogueParagraph({ path, item, reads });
            if (record.sourceReview.flags.length) edition.eligible = false;
            record.editions.push(edition);
          } catch {
            record.editions.push({
              kind: "paragraph",
              path,
              eligible: false,
              reading: "review",
              reason: "stale-or-edited-evidence",
            });
          }
        }
    }
  }
  for (const path of paths.filter((path) => /\.recovered-[0-9a-f]{32}\.md$/.test(path))) {
    let record;
    try {
      const provenance = catalogueJson(await reads.file(path + ".provenance.json"));
      const claimed = records.get(provenance.recordingId);
      const association = claims.find((claim) => claim.job.recordingId === provenance.recordingId);
      if (!claimed || !association || !association.job.placement?.formattedTranscriptPath)
        throw catalogueFailure();
      const original = resolve(
        association.course.path,
        association.job.placement.formattedTranscriptPath,
      );
      const expected = join(
        dirname(original),
        `${basename(original, ".md")}.recovered-${provenance.runId}.md`,
      );
      if (
        !insideHistoricalRoot(association.course.path, original) ||
        path !== expected ||
        provenance.originalDerivative?.path !== original ||
        provenance.originalSource?.path !==
          join(
            mediaRecordingRoot(
              historical.roots.find((root) => !root.courseKey).path,
              provenance.recordingId,
            ),
            "transcript.raw.json",
          )
      )
        throw catalogueFailure();
      record = claimed;
      const proof = await catalogueRecovery({ path, reports, config, reads, signal });
      const course = courses.find((course) => course.recordings.includes(record));
      if (proof.recording.courseKey !== course.key || !insideHistoricalRoot(course.path, path))
        throw catalogueFailure();
      for (const input of proof.ownership.protectedInputs) {
        const prior = reads.files.get(input.path);
        if (prior && prior.sha256 !== input.sha256)
          throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
      }
      // Access may link owned video while recovery used separately owned audio.
      // Complete every proof/pin check before admitting an eligible reading edition.
      let recoveryMedia = mediaIdentities.get(proof.ownership.mediaIdentity.path);
      if (!recoveryMedia) {
        const boundary = historical.roots.find((root) =>
          insideHistoricalRoot(root.path, proof.ownership.mediaIdentity.path),
        )?.path;
        if (!boundary) throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
        recoveryMedia = await reads.media.read(proof.ownership.mediaIdentity.path, boundary);
        if (recoveryMedia.sha256 !== proof.recording.media.sha256)
          throw catalogueFailure("CATALOGUE_INPUT_CHANGED");
      }
      mediaIdentities.set(recoveryMedia.path, recoveryMedia);
      for (const input of proof.ownership.protectedInputs) {
        const prior = reads.files.get(input.path);
        reads.files.set(input.path, {
          ...input,
          ...(prior?.content ? { content: prior.content } : {}),
        });
      }
      for (const absence of proof.ownership.protectedAbsences ?? [])
        reads.absences.set(absence.path, absence);
      record.source = proof.recording.source.path;
      record.original = proof.recording.original.absent ? null : proof.recording.original.path;
      record.statusPath = proof.ownership.recordings[0].display.statusPath;
      usedPaths.add(record.source);
      if (record.original) usedPaths.add(record.original);
      record.editions.push(proof.edition);
    } catch (error) {
      if (/^CATALOGUE_MEDIA_/.test(error.code ?? "") || isGlobalMediaSafetyFailure(error))
        throw error;
      if (record)
        record.editions.push({
          kind: "recovered",
          path,
          eligible: false,
          reading: "review",
          reason: "stale-or-edited-evidence",
        });
      else unassociated.push({ path, kind: "recovered", reason: "unproven-association" });
    }
  }
  for (const [id, record] of records) {
    for (const edition of record.editions)
      if (edition.eligible) edition.selectionSha256 = edition.equivalence ?? edition.sha256;
    const choice = preferredCatalogueEdition(record.editions, selected.get(id));
    Object.assign(record, choice);
    record.reading = choice.preferred
      ? "verified"
      : record.editions.length || record.sourceReview.flags.length
        ? "review"
        : record.reading;
    selected.delete(id);
  }
  if (selected.size) throw catalogueFailure("CATALOGUE_SELECTION_INVALID");
  for (const source of historical.sources)
    if (!usedPaths.has(source.path))
      unassociated.push({
        path: source.path,
        kind: source.kind,
        reason: source.association,
        flags: source.flags,
        timing: source.timing,
      });
  for (const derivative of historical.derivatives)
    if (!usedPaths.has(derivative.path))
      unassociated.push({
        path: derivative.path,
        kind: "original",
        reason: derivative.association,
        flags: derivative.flags,
      });
  for (const path of paths.filter((path) =>
    /\/source-paragraphs-v1-[0-9a-f]{24}\/recording-[0-9a-f]{24}\.md$/.test(path),
  ))
    if (
      !courses.some((course) =>
        course.recordings.some((record) =>
          record.editions.some((edition) => edition.path === path),
        ),
      )
    )
      unassociated.push({ path, kind: "paragraph", reason: "unproven-association" });
  // Logical configured aliases are rechecked independently of canonical content hashes.
  const bindings = await Promise.all(
    config.courses.map(async (course) => ({
      logical: resolve(course.destination),
      canonical: await reads.probe(() => realpath(course.destination)),
    })),
  );
  bindings.push({
    logical: resolve(config.media.mediaRoot),
    canonical: await reads.probe(() => realpath(config.media.mediaRoot)),
  });
  for (const course of courses)
    course.counts = {
      appearances:
        course.recordings.length + course.unresolved.length + course.nonRecordings.length,
      recordings: course.recordings.length,
      unresolved: course.unresolved.length,
      nonRecordings: course.nonRecordings.length,
    };
  reads.active();
  return {
    schemaVersion: 1,
    policy: CATALOGUE_POLICY,
    authority:
      "Configured local queues and retained transcript evidence; no upstream completeness or acoustic accuracy claim.",
    courses,
    unassociated,
    scannedPaths: [...paths].sort(),
    mediaIdentities: [...mediaIdentities.values()].sort((a, b) => a.path.localeCompare(b.path)),
    inputs: [...reads.files.values()]
      .map(catalogueFingerprint)
      .sort((a, b) => a.path.localeCompare(b.path)),
    absences: [...reads.absences.values()].sort((a, b) => a.path.localeCompare(b.path)),
    bindings,
    profileBinding,
  };
}
