import { dirname, join, basename } from "node:path";
import { historicalDigest } from "./historical-files.mjs";
import { HISTORICAL_FORMAT_VERSION } from "./historical-format.mjs";
import { assessRecoveryTranscript } from "./recovery-candidate.mjs";
import { readCurrentRecoveryOwnership } from "./recovery-manifest.mjs";
import { RECOVERY_POLICIES } from "./recovery-policy.mjs";
import { catalogueFailure, catalogueJson } from "./catalogue-files.mjs";

export async function catalogueParagraph({ path, item, reads }) {
  const edition = await reads.file(path),
    provenanceFile = await reads.file(path + ".provenance.json"),
    provenance = catalogueJson(provenanceFile),
    receipt = catalogueJson(await reads.file(path + ".receipt.json"));
  const expected = {
    schemaVersion: 1,
    policy: HISTORICAL_FORMAT_VERSION,
    recordingId: item.recordingId,
    sourcePath: item.sourcePath,
    sourceSha256: item.sourceSha256,
    originalPath: item.originalPath,
    originalSha256: item.originalSha256,
    editionSha256: historicalDigest(item.markdown),
    sourceFlags: item.sourceFlags,
    timing: item.timing,
    mediaReadiness: "unclaimed",
  };
  if (
    JSON.stringify(provenance) !== JSON.stringify(expected) ||
    edition.sha256 !== expected.editionSha256 ||
    receipt.schemaVersion !== 1 ||
    receipt.outputPath !== path ||
    receipt.outputSha256 !== edition.sha256 ||
    receipt.sourceSha256 !== item.sourceSha256 ||
    receipt.stage !== "published" ||
    receipt.originalUnchanged !== true ||
    receipt.mediaReadiness !== "unclaimed" ||
    basename(dirname(path)) !== `${HISTORICAL_FORMAT_VERSION}-${receipt.planId}`
  )
    throw catalogueFailure();
  const provenanceReceipt = catalogueJson(await reads.file(path + ".provenance.json.receipt.json"));
  if (
    provenanceReceipt.planId !== receipt.planId ||
    provenanceReceipt.outputPath !== provenanceFile.path ||
    provenanceReceipt.outputSha256 !== provenanceFile.sha256 ||
    provenanceReceipt.stage !== "published" ||
    provenanceReceipt.originalUnchanged !== true
  )
    throw catalogueFailure();
  return {
    kind: "paragraph",
    equivalence: historicalDigest(
      JSON.stringify({
        kind: "paragraph",
        source: item.sourceSha256,
        original: item.originalSha256,
        timing: item.timing,
        flags: item.sourceFlags,
        edition: edition.sha256,
      }),
    ),
    path,
    sha256: edition.sha256,
    provenance: provenanceFile.path,
    eligible: item.sourceFlags.length === 0 && item.timing !== "failed",
    timing: item.timing,
    flags: item.sourceFlags,
    reading: "verified",
  };
}

export async function catalogueRecovery({ path, reports, config, reads, signal }) {
  const provenanceFile = await reads.file(path + ".provenance.json"),
    provenance = catalogueJson(provenanceFile);
  const matches = reports.filter(({ report }) => report.runId === provenance.runId);
  if (matches.length !== 1) throw catalogueFailure("CATALOGUE_RECOVERY_AMBIGUOUS");
  const { report, directory } = matches[0],
    plan = catalogueJson(await reads.file(join(directory, "plan.json")));
  if (
    report.schemaVersion !== 1 ||
    report.failureCode ||
    !RECOVERY_POLICIES.includes(plan.policy) ||
    JSON.stringify(plan) !== JSON.stringify(report.manifest)
  )
    throw catalogueFailure();
  const recordings = plan.recordings.filter(
    (entry) => entry.recordingId === provenance.recordingId,
  );
  if (recordings.length !== 1) throw catalogueFailure();
  const recording = recordings[0],
    candidates = report.candidates.filter((entry) => entry.id === recording.id);
  if (candidates.length !== 1) throw catalogueFailure();
  const retained = candidates[0],
    files = new Map();
  for (const suffix of ["source.json", "native-asr.json", "assessment.json", "paragraphs.md"]) {
    const name = `${recording.id}.${suffix}`,
      file = await reads.file(join(directory, name));
    const pins = retained.files.filter((pin) => pin.name === name);
    if (pins.length !== 1 || pins[0].sha256 !== file.sha256 || pins[0].bytes !== file.bytes)
      throw catalogueFailure();
    files.set(suffix, file);
  }
  if (retained.files.length !== 4) throw catalogueFailure();
  const { candidate, markdown } = assessRecoveryTranscript({
    source: catalogueJson(files.get("source.json")),
    native: catalogueJson(files.get("native-asr.json")),
    duration: retained.duration,
    id: recording.id,
  });
  if (
    !candidate.eligible ||
    candidate.timing !== "passed" ||
    JSON.stringify(candidate) !== JSON.stringify(catalogueJson(files.get("assessment.json"))) ||
    JSON.stringify({ ...candidate, files: retained.files }) !== JSON.stringify(retained) ||
    files.get("paragraphs.md").content.toString("utf8") !== markdown
  )
    throw catalogueFailure("CATALOGUE_RECOVERY_REVIEW");
  const expected = {
    schemaVersion: 1,
    runId: report.runId,
    policy: plan.policy,
    recordingId: recording.recordingId,
    display: recording.display,
    originalSource: recording.source,
    originalDerivative: recording.original,
    media: recording.media,
    generatedSourceSha256: files.get("source.json").sha256,
    generatedNativeSha256: files.get("native-asr.json").sha256,
    runtimePins: report.runtimePins,
    assessment: candidate,
    originalPreserved: true,
    authority: recording.authority,
    canonicalSourceReplacement: false,
    acousticVerification: "unrun",
    mediaReadiness: "unclaimed",
  };
  if (
    JSON.stringify(provenance) !== JSON.stringify(expected) ||
    path !==
      join(
        dirname(recording.original.path),
        `${basename(recording.original.path, ".md")}.recovered-${report.runId}.md`,
      )
  )
    throw catalogueFailure();
  const edition = await reads.file(path);
  if (edition.content.toString("utf8") !== markdown)
    throw catalogueFailure("CATALOGUE_EDITION_EDITED");
  for (const [suffix, retainedName] of [
    ["source", "source.json"],
    ["native-asr", "native-asr.json"],
  ])
    if ((await reads.file(path + `.${suffix}.json`)).sha256 !== files.get(retainedName).sha256)
      throw catalogueFailure();
  const ownership = await readCurrentRecoveryOwnership({
    recording,
    policy: plan.policy,
    config,
    signal,
  });
  return {
    recording,
    ownership,
    edition: {
      kind: "recovered",
      policy: plan.policy,
      equivalence: historicalDigest(
        JSON.stringify({
          kind: "recovered",
          policy: plan.policy,
          originalSource: recording.source,
          originalDerivative: recording.original,
          media: recording.media,
          source: expected.generatedSourceSha256,
          native: expected.generatedNativeSha256,
          runtime: expected.runtimePins,
          assessment: { ...candidate, id: undefined },
          edition: edition.sha256,
        }),
      ),
      path,
      sha256: edition.sha256,
      provenance: provenanceFile.path,
      eligible: true,
      timing: "passed",
      flags: [],
      reading: "verified",
    },
  };
}

export function preferredCatalogueEdition(editions, selection) {
  const eligible = editions.filter((edition) => edition.eligible),
    tier = eligible.some((edition) => edition.kind === "recovered") ? "recovered" : "paragraph";
  const choices = eligible.filter((edition) => edition.kind === tier);
  const groups = new Map();
  for (const edition of choices) {
    const key = edition.equivalence ?? edition.sha256;
    const group = groups.get(key) ?? [];
    group.push(edition);
    groups.set(key, group);
  }
  const matches = selection
    ? [...groups.entries()].filter(
        ([key, group]) => key === selection || group[0].sha256 === selection,
      )
    : [];
  if (selection && matches.length !== 1) throw catalogueFailure("CATALOGUE_SELECTION_INVALID");
  if (groups.size > 1 && !selection)
    return { preferred: null, reason: "ambiguous-eligible-editions" };
  const group = selection ? matches[0][1] : [...groups.values()][0];
  if (!group)
    return { preferred: null, reason: editions.length ? "edition-review" : "edition-incomplete" };
  const sorted = [...group].sort((a, b) => a.path.localeCompare(b.path));
  return {
    preferred: {
      ...sorted[0],
      selectionSha256: sorted[0].equivalence ?? sorted[0].sha256,
      equivalents: sorted.slice(1).map((edition) => edition.path),
    },
    reason: null,
  };
}
