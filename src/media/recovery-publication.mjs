import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";
import { assessRecoveryTranscript } from "./recovery-candidate.mjs";
import { historicalReads, publishHistoricalFile, historicalDigest } from "./historical-files.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { assertRecoveryInputs } from "./recovery-manifest.mjs";
import { evaluationOutputRoot } from "./evaluation-storage.mjs";
import { VAD_RECOVERY_POLICY } from "./recovery-policy.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { verifyRecoveryVad, assertRecoveryVadInputs } from "./vad.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";

export async function publishRecoveryCandidates(
  { manifest, outputDirectory, config, signalProcessGroup, signal },
  dependencies = {},
) {
  const progress = {
    outputs: 0,
    written: 0,
    existing: 0,
    publishedCandidates: 0,
    eligible: 0,
    review: 0,
    publication: "unrun",
  };
  try {
    return await publishCandidates(
      { manifest, outputDirectory, config, signalProcessGroup, signal },
      dependencies,
      progress,
    );
  } catch (error) {
    error.recoveryEvidence = {
      ...progress,
      partialPublication:
        progress.written || progress.existing ? "retained-exclusive-files" : "none",
      retry:
        "Retry media:recover publish with the same unchanged private manifest and candidate directory.",
    };
    throw error;
  }
}

async function publishCandidates(
  { manifest, outputDirectory, config, signalProcessGroup, signal },
  dependencies,
  progress,
) {
  const output = resolve(outputDirectory);
  const root = await evaluationOutputRoot(config.media, config.media.mediaRoot, {
    ...(dependencies.volumeRoot ? { volumeRoot: dependencies.volumeRoot } : {}),
  });
  if (!output.startsWith(root + sep)) throw recoveryFailure("RECOVERY_OUTPUT_INVALID");
  const plan = await recoveryFile(join(output, "plan.json"), { signal });
  if (JSON.stringify(JSON.parse(plan.content.toString("utf8"))) !== JSON.stringify(manifest))
    throw recoveryFailure("RECOVERY_INPUT_CHANGED");
  const reportFile = await recoveryFile(join(output, "recovery.json"), { signal });
  const report = JSON.parse(reportFile.content.toString("utf8"));
  safeNativeTranscriptBody(report);
  if (
    report.schemaVersion !== 1 ||
    !/^[0-9a-f]{32}$/.test(report.runId ?? "") ||
    report.failureCode ||
    JSON.stringify(report.manifest) !== JSON.stringify(manifest) ||
    !Array.isArray(report.candidates) ||
    report.candidates.length !== manifest.recordings.length
  )
    throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
  let vad;
  if (manifest.policy === VAD_RECOVERY_POLICY) {
    const runtime = await (dependencies.verifyRuntime ?? verifyMediaRuntime)(config.media, {
      signal,
      signalProcessGroup,
    });
    vad = await (dependencies.verifyVad ?? verifyRecoveryVad)(
      { runtime, signal },
      { signal, signalProcessGroup },
    );
    const pins = [
      ...runtime.artifacts.map(({ key, sha256 }) => ({ key, sha256 })),
      vad.pin,
      vad.delegatePin,
    ];
    if (JSON.stringify(report.runtimePins) !== JSON.stringify(pins))
      throw recoveryFailure("RECOVERY_VAD_UNPREPARED");
  }
  const outputs = [],
    courseIndexes = new Map(),
    reviewEntries = [],
    protectedCandidates = [plan, reportFile];
  for (const recording of manifest.recordings) {
    const matches = report.candidates.filter((candidate) => candidate.id === recording.id);
    if (matches.length !== 1) throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
    const retained = matches[0];
    if (!Array.isArray(retained.files)) throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
    const suffixes = [
      "native-asr.json",
      "source.json",
      "assessment.json",
      ...(retained.formatting === "passed" ? ["paragraphs.md"] : []),
    ];
    if (retained.files.length !== suffixes.length)
      throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
    const files = new Map();
    for (const suffix of suffixes) {
      const name = `${recording.id}.${suffix}`;
      const proofs = retained.files.filter((file) => file.name === name);
      if (proofs.length !== 1) throw recoveryFailure("RECOVERY_CANDIDATE_INVALID");
      const file = await recoveryFile(join(output, name), { maximumBytes: 16 * 1024 ** 2, signal });
      if (file.sha256 !== proofs[0].sha256 || file.bytes !== proofs[0].bytes)
        throw recoveryFailure("RECOVERY_CANDIDATE_EDITED");
      files.set(suffix, file);
      protectedCandidates.push(file);
    }
    const source = JSON.parse(files.get("source.json").content.toString("utf8"));
    const native = JSON.parse(files.get("native-asr.json").content.toString("utf8"));
    const { candidate, markdown } = assessRecoveryTranscript({
      native,
      source,
      duration: retained.duration,
      id: recording.id,
    });
    if (
      JSON.stringify(candidate) !==
        JSON.stringify(JSON.parse(files.get("assessment.json").content.toString("utf8"))) ||
      (markdown !== null && files.get("paragraphs.md")?.content.toString("utf8") !== markdown)
    )
      throw recoveryFailure("RECOVERY_CANDIDATE_REVIEW");
    if (!candidate.eligible) {
      progress.review++;
      reviewEntries.push({ recording, candidate });
      continue;
    }
    progress.eligible++;
    const key = createHash("sha256").update(recording.recordingId).digest("hex").slice(0, 24);
    const folder = dirname(recording.original.path);
    const edition = join(
      folder,
      `${basename(recording.original.path, ".md")}.recovered-${report.runId}.md`,
    );
    const candidateSource = edition + ".source.json",
      nativeSource = edition + ".native-asr.json",
      provenancePath = edition + ".provenance.json";
    const provenance = {
      schemaVersion: 1,
      runId: report.runId,
      policy: manifest.policy,
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
    const body = markdown;
    for (const [path, content] of [
      [candidateSource, files.get("source.json").content],
      [nativeSource, files.get("native-asr.json").content],
      [provenancePath, JSON.stringify(provenance, null, 2) + "\n"],
      [edition, body],
    ])
      outputs.push({
        path,
        content,
        boundary: recording.coursePath,
        ...(path === edition ? { candidateEdition: true } : {}),
      });
    const entries = courseIndexes.get(recording.coursePath) ?? [];
    entries.push(
      `${link(recording.display.title, edition)} (${escapeText(recording.display.courseKey)}; recording ${key})\n  ${upstreamLink("NTULearn course", recording.display.courseUrl)} · source reference: ${escapeText(recording.display.sourceReference)}\n  ${recording.original.absent ? "Original derivative absent (pinned)" : link("Original", recording.original.path)} · ${link("Original source", recording.source.path)} · ${link("Retained media", recording.media.path)} · ${recording.display.statusPath ? link("Current media status", recording.display.statusPath) : "Current media status unavailable"} · ${link("Candidate source", candidateSource)} · ${link("Native ASR", nativeSource)} · ${link("Provenance and limitations", provenancePath)}`,
    );
    courseIndexes.set(recording.coursePath, entries);
  }
  for (const [coursePath, entries] of courseIndexes)
    outputs.push({
      path: join(coursePath, "Transcript editions", `asr-recovery-v1-${report.runId}`, "index.md"),
      content: `# Fresh ASR transcript candidates\n\nSource wording preserved from the new candidate. Originals retained. Context mitigation unmeasured; acoustic verification unrun; media readiness unclaimed.\n\n${entries.map((entry) => "- " + entry).join("\n")}\n${reviewEntries
        .filter((entry) => entry.recording.coursePath === coursePath)
        .map(
          ({ recording, candidate }) =>
            `\n- ${escapeText(recording.display.title)} — unpublished / review: ${escapeText(candidate.flags.join(", ") || "native source or timing failed")}; ${recording.original.absent ? "Original derivative absent (pinned)" : link("Original", recording.original.path)}; ${upstreamLink("NTULearn course", recording.display.courseUrl)}.`,
        )
        .join("\n")}\n`,
      boundary: coursePath,
    });
  const totalBytes = outputs.reduce((sum, output) => sum + Buffer.byteLength(output.content), 0);
  if (totalBytes > Math.min(manifest.budgets.maxOutputBytes, 256 * 1024 ** 2))
    throw recoveryFailure("RECOVERY_OUTPUT_BUDGET");
  const reads = historicalReads({ signal });
  progress.outputs = outputs.length;
  if (!outputs.length)
    return { ...progress, publication: "review-only", mitigation: "unmeasured-context-limitation" };
  const capacity = await (dependencies.createCapacity ?? createMediaCapacity)(config.media, {
    courses: config.courses,
  });
  const recheckPublicationEvidence = async () => {
    for (const protectedFile of protectedCandidates) {
      const current = await recoveryFile(protectedFile.path, {
        maximumBytes: 16 * 1024 ** 2,
        signal,
      });
      if (current.sha256 !== protectedFile.sha256)
        throw recoveryFailure("RECOVERY_CANDIDATE_EDITED");
    }
    await assertRecoveryInputs(manifest, signal, { includeMedia: false });
    if (vad) await assertRecoveryVadInputs(vad, signal);
  };
  for (const outputFile of outputs) {
    signal?.throwIfAborted();
    await recheckPublicationEvidence();
    const content = Buffer.from(outputFile.content);
    const outcome = await publishHistoricalFile(outputFile.path, content, {
      reads,
      boundary: outputFile.boundary,
      checkCapacity: async (request) => {
        await capacity.check(request);
        await recheckPublicationEvidence();
      },
      expectedSha256: historicalDigest(content),
    });
    if (outcome === "written") progress.written++;
    else progress.existing++;
    if (outputFile.candidateEdition) progress.publishedCandidates++;
    progress.publication = "partial-candidate-editions";
    await dependencies.afterOutput?.({ written: progress.written, existing: progress.existing });
  }
  await assertRecoveryInputs(manifest, signal);
  if (vad) await assertRecoveryVadInputs(vad, signal);
  return {
    ...progress,
    publication: "candidate-editions",
    mitigation: "unmeasured-context-limitation",
  };
}

function link(label, path) {
  return `[${escapeText(label)}](<${pathToFileURL(path).href}>)`;
}

function escapeText(value) {
  return String(value)
    .replace(/[\\`*_{}[\]()<>#|]/g, (character) => "\\" + character)
    .replace(/[\r\n]+/g, " ");
}
function upstreamLink(label, url) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://ntulearn.ntu.edu.sg" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw recoveryFailure("RECOVERY_ASSOCIATION_INVALID");
  return `[${escapeText(label)}](<${parsed.href}>)`;
}
