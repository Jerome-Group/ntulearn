import { recordingDisposition } from "./disposition.mjs";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { isMediaJobComplete } from "./completeness.mjs";
import { durationLabel, positiveDuration } from "./duration.mjs";
import { publicMediaError } from "./errors.mjs";
import { assertMediaArtifactPath, mediaRecordingRoot } from "./storage.mjs";
import { mediaArtifactEvidenceUpdate } from "./worker-state.mjs";

const STATUS_DIRECTORY = "Media Gallery";
const COURSE_STATUS_FILENAME = "media-status.md";

export function mediaCourseStatusPath(course) {
  return resolveStatusPath(course?.destination, `${STATUS_DIRECTORY}/${COURSE_STATUS_FILENAME}`);
}

export function mediaRecordingStatusPath(appearance) {
  return resolveStatusPath(appearance?.placement?.destination, appearance?.placement?.statusPath);
}

export function mediaCourseStatus({ course, discovery = {}, queue = [], now = () => new Date() }) {
  const recordings = queue.map((job) => mediaRecordingStatus({ appearance: job, job, now }));
  const counts = countRecordings(recordings);
  const limitations = unique(
    [
      ...(Array.isArray(discovery.limitations) ? discovery.limitations : []),
      ...recordings.flatMap((recording) => recording.limitations),
    ].map((limitation) => publicMediaError(limitation)),
  );
  const verdict = courseVerdict({ course, discovery, recordings, counts });

  return {
    version: 1,
    courseKey: course?.key ?? null,
    courseId: course?.courseId ?? null,
    mediaMode: course?.mediaMode ?? "off",
    verdict,
    discovery: discovery.complete === true ? "complete" : "incomplete",
    counts,
    recordings,
    limitations,
    updatedAt: asDate(typeof now === "function" ? now() : now).toISOString(),
  };
}

export async function writeMediaCourseStatus({
  course,
  discovery = {},
  queue = [],
  now = () => new Date(),
  write = writeAtomically,
  mediaRoot = null,
}) {
  if (!course?.destination) return null;
  const checkedQueue = await Promise.all(
    queue.map((job) => checkArtifactAvailability(job, { course, mediaRoot })),
  );
  const status = mediaCourseStatus({ course, discovery, queue: checkedQueue, now });
  const path = mediaCourseStatusPath(course);
  await assertMediaArtifactPath(path, course.destination);
  await write(path, `${courseStatusMarkdown(status)}\n`);
  return { path, status: "written", verdict: status.verdict };
}

export async function writeMediaRecordingStatus({
  appearance,
  job = appearance,
  now = () => new Date(),
  write = writeAtomically,
  mediaRoot = null,
}) {
  const path = mediaRecordingStatusPath(appearance);
  if (!path) return null;
  const checked = await checkArtifactAvailability(
    { ...appearance, ...job },
    { course: { destination: appearance.placement.destination }, mediaRoot },
  );
  const status = mediaRecordingStatus({ appearance, job: checked, now });
  await assertMediaArtifactPath(path, appearance.placement.destination);
  await write(path, `${recordingStatusMarkdown(status)}\n`);
  return { path, status: "written", verdict: status.verdict };
}

export function mediaRecordingStatus({ appearance = {}, job = {}, now = () => new Date() }) {
  const disposition = recordingDisposition({ ...appearance, ...job });
  const withdrawn = job.withdrawn === true || job.stage === "withdrawn";
  const declaredComplete = job.complete === true || job.stage === "complete";
  const media = normalizedMedia(job.media);
  const transcript = normalizedTranscript(job.transcript);
  if (disposition !== "recording") {
    transcript.complete = false;
    transcript.provenance =
      disposition === "non-recording"
        ? "not applicable; no transcript completeness claimed"
        : "unresolved appearance; prior transcript evidence, if any, is retained without a completeness claim";
  }
  const limitations = unique(
    [
      ...(Array.isArray(job.limitations) ? job.limitations : []),
      ...(declaredComplete && !transcript.complete
        ? ["A valid source and formatted Markdown derivative are required."]
        : []),
      ...(withdrawn ? ["Upstream withdrawal confirmed; acquired artifacts retained."] : []),
    ].map((limitation) => publicMediaError(limitation)),
  );
  const complete = isMediaJobComplete({ ...job, transcript });
  const stage =
    !withdrawn && disposition !== "recording"
      ? disposition === "non-recording"
        ? "excluded"
        : "unresolved"
      : withdrawn
        ? "withdrawn"
        : (job.stage ?? (complete ? "complete" : "queued"));
  const verdict =
    !withdrawn && disposition !== "recording"
      ? disposition === "non-recording"
        ? "green"
        : "red"
      : withdrawn
        ? "green"
        : declaredComplete && !complete
          ? "red"
          : (job.verdict ?? (complete ? (limitations.length ? "yellow" : "green") : "yellow"));

  return {
    disposition,
    classificationEvidence:
      job.classificationEvidence ??
      appearance.classificationEvidence ??
      "legacy declaration; resource disposition not independently evidenced",
    recordingId: job.recordingId ?? appearance.recordingId ?? null,
    title: cleanText(job.title ?? appearance.title ?? "Untitled recording"),
    provider: job.providerName ?? job.provider ?? appearance.provider ?? "unknown",
    sourceKind: job.sourceKind ?? appearance.sourceKind ?? "unknown",
    sourceReference: stableReference(job.providerReference ?? appearance.providerReference),
    locations: artifactLocations(appearance, job),
    artifactIntegrity:
      job.artifactIntegrity ??
      "queue declaration; artifact integrity and speech quality unverified",
    stage,
    verdict,
    complete,
    retryable: disposition === "recording" && !withdrawn && job.retryable !== false,
    transcript,
    media,
    ...durationFields(job),
    limitations,
    attempts: Number.isSafeInteger(job.attempts) ? job.attempts : 0,
    lastError: job.lastError ? publicMediaError(job.lastError) : null,
    artifacts: job.artifacts && typeof job.artifacts === "object" ? job.artifacts : {},
    updatedAt: asDate(typeof now === "function" ? now() : now).toISOString(),
  };
}

function countRecordings(recordings) {
  return recordings.reduce(
    (counts, recording) => {
      counts.total += 1;
      if (recording.stage === "withdrawn") counts.withdrawn += 1;
      else if (recording.disposition === "non-recording") counts.excluded += 1;
      else if (recording.disposition === "unresolved") counts.unresolved += 1;
      else if (recording.complete) counts.complete += 1;
      else if (recording.verdict === "red" || recording.stage === "failed") counts.failed += 1;
      else if (recording.stage === "active") counts.active += 1;
      else if (recording.stage === "checkpointed") counts.checkpointed += 1;
      else counts.queued += 1;
      return counts;
    },
    {
      excluded: 0,
      unresolved: 0,
      total: 0,
      complete: 0,
      queued: 0,
      active: 0,
      checkpointed: 0,
      failed: 0,
      withdrawn: 0,
    },
  );
}

function courseVerdict({ course, discovery, recordings, counts }) {
  if (course?.mediaMode === "off") return "green";
  if (discovery.complete !== true || discovery.verdict === "red") return "red";
  if (
    counts.unresolved ||
    counts.failed ||
    recordings.some((recording) => recording.verdict === "red")
  )
    return "red";
  if (
    counts.queued ||
    counts.active ||
    counts.checkpointed ||
    recordings.some((recording) => recording.verdict === "yellow")
  ) {
    return "yellow";
  }
  return "green";
}

function normalizedTranscript(value) {
  const complete = value?.complete === true;
  const sourceKind = typeof value?.sourceKind === "string" ? cleanText(value.sourceKind) : null;
  const language = typeof value?.language === "string" ? cleanText(value.language) : null;
  return {
    complete,
    sourceKind,
    language,
    provenance: complete
      ? `${sourceKind ?? "unknown"} source + formatted Markdown`
      : sourceKind
        ? `${sourceKind} source; formatted Markdown missing`
        : "not complete",
  };
}

function normalizedMedia(value) {
  return {
    video: normalizedMediaKind(value?.video),
    audio: normalizedMediaKind(value?.audio),
  };
}

function normalizedMediaKind(value) {
  return {
    available: value?.available === true,
    quality: Number.isFinite(value?.quality) ? value.quality : null,
    availabilityVerified: value?.availabilityVerified !== false,
    declaredAvailable: value?.declaredAvailable === true,
  };
}

function courseStatusMarkdown(status) {
  const lines = [
    `# ${cleanText(status.courseKey ?? "Course")} — media status`,
    "",
    `- Course ID: ${cleanText(status.courseId ?? "unknown")}`,
    `- Media mode: ${cleanText(status.mediaMode)}`,
    `- Verdict: ${status.verdict}`,
    `- Discovery: ${status.discovery}`,
    `- Discovered appearances: ${status.counts.total}`,
    `- Excluded non-recordings: ${status.counts.excluded}`,
    `- Unresolved appearances: ${status.counts.unresolved}`,
    `- Complete: ${status.counts.complete}`,
    `- Queued: ${status.counts.queued}`,
    `- Active: ${status.counts.active}`,
    `- Checkpointed: ${status.counts.checkpointed}`,
    `- Failed: ${status.counts.failed}`,
    `- Withdrawn: ${status.counts.withdrawn}`,
    `- Limitations: ${status.limitations.length ? status.limitations.join(" ") : "None"}`,
    `- Updated: ${status.updatedAt}`,
  ];

  if (status.mediaMode === "off") {
    lines.push("", "Media processing is excluded for this course.");
  } else if (status.recordings.length) {
    lines.push("", "## Recordings", "");
    for (const recording of status.recordings) {
      lines.push(...recordingLines(recording), "");
    }
  }
  return lines.join("\n").trimEnd();
}

function recordingStatusMarkdown(status) {
  return [
    `# ${status.title} — media status`,
    "",
    `- Recording: ${cleanText(status.recordingId ?? "unknown")}`,
    ...recordingFields(status),
    "",
  ].join("\n");
}

function recordingLines(recording) {
  return [
    `### ${recording.title}`,
    `- Recording: ${cleanText(recording.recordingId ?? "unknown")}`,
    ...recordingFields(recording),
  ];
}

function recordingFields(recording) {
  return [
    `- Disposition: ${recording.disposition}`,
    `- Classification evidence: ${recording.classificationEvidence}`,
    `- Provider: ${displayName(recording.provider)}`,
    `- Source: ${cleanText(recording.sourceKind)}`,
    `- Stage: ${recording.stage}`,
    `- State: ${recording.disposition === "non-recording" ? "excluded from acquisition; transcript completeness not claimed" : recording.disposition === "unresolved" ? "unresolved; inspect in NTULearn and rediscover with positive metadata" : recording.complete ? (recording.artifactIntegrity.startsWith("source and derivative digests verified") ? "ready (local artifact digests verified)" : "declared complete / integrity pending") : recording.verdict === "red" ? "failed / incomplete" : "incomplete"}`,
    ...(recording.sourceReference ? [`- Source reference: ${recording.sourceReference}`] : []),
    ...recording.locations.map(
      ({ label, path, available, unverified }) =>
        `- ${label}: ${available ? `[Open](<${encodeURI(path).replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("#", "%23").replaceAll("?", "%3F")}>)` : `${unverified ? "declared / unverified" : "unavailable"} (${cleanText(path)})`}`,
    ),
    `- Evidence: ${recording.artifactIntegrity}`,
    `- Verdict: ${recording.verdict}`,
    `- Video: ${mediaAvailability(recording.media.video)}`,
    `- Audio: ${mediaAvailability(recording.media.audio)}`,
    `- Duration: ${durationLabel(recording.duration)}`,
    ...(positiveDuration(recording.speechDuration)
      ? [`- Speech duration: ${durationLabel(recording.speechDuration)}`]
      : []),
    `- Transcript provenance: ${recording.transcript.provenance}`,
    `- Retryable: ${recording.retryable ? "yes" : "no"}`,
    `- Attempts: ${recording.attempts}`,
    `- Limitations: ${recording.limitations.length ? recording.limitations.join(" ") : "None"}`,
    ...(recording.lastError ? [`- Last error: ${recording.lastError}`] : []),
    `- Updated: ${recording.updatedAt}`,
  ];
}

function mediaAvailability(value) {
  if (!value.availabilityVerified)
    return `unverified (queue reports ${value.declaredAvailable ? "available" : "unavailable"})`;
  return value.available
    ? `available${value.quality ? ` (${value.quality}p)` : ""}`
    : "unavailable";
}

function durationFields(job) {
  return {
    ...(positiveDuration(job.duration) ? { duration: job.duration } : {}),
    ...(positiveDuration(job.speechDuration) ? { speechDuration: job.speechDuration } : {}),
  };
}

function displayName(value) {
  return cleanText(value ?? "unknown")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanText(value) {
  return (
    String(value ?? "unknown")
      .replace(/[\r\n]+/g, " ")
      .trim() || "unknown"
  );
}

function unique(values) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function resolveStatusPath(destination, relativePath) {
  if (typeof destination !== "string" || !destination) return null;
  if (typeof relativePath !== "string" || !relativePath) return null;
  const root = resolve(destination);
  const target = resolve(root, ...relativePath.split(/[\\/]+/).filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `Unsafe media status path: ${relativePath}. Check the course destination and status path.`,
    );
  }
  return target;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Media status time must be a valid date. Check the media clock value.");
  }
  return date;
}

function stableReference(value) {
  if (typeof value !== "string") return null;
  return cleanText(value.split(/[?#&\s]/, 1)[0]);
}

function artifactLocations(appearance, job) {
  const placement = job.placement ?? appearance.placement;
  const artifacts = job.artifacts ?? {};
  const entries = [
    ["Recording media", artifacts.media],
    ["Source transcript", artifacts.rawTranscript],
    ["Formatted transcript", artifacts.formattedTranscript],
    [
      "Recording status",
      placement?.destination && placement?.statusPath
        ? resolveStatusPath(placement.destination, placement.statusPath)
        : null,
    ],
  ];
  return entries.flatMap(([label, path]) => {
    if (typeof path !== "string" || !path.startsWith("/") || /[\0\r\n]|:\/\//.test(path)) return [];
    return [
      {
        label,
        path,
        available: label === "Recording status" || job.availableArtifacts?.includes(path) === true,
        unverified: !job.checkedArtifacts?.includes(path) && label !== "Recording status",
      },
    ];
  });
}

async function checkArtifactAvailability(job, { course, mediaRoot } = {}) {
  const artifacts = job.artifacts ?? {};
  const destination = course?.destination ?? job.placement?.destination;
  const recordingRoot = mediaRoot ? mediaRecordingRoot(mediaRoot, job.recordingId) : null;
  const entries = Object.entries(artifacts).flatMap(([kind, path]) => {
    if (typeof path !== "string" || !path.startsWith("/") || /[\0\r\n]|:\/\//.test(path)) return [];
    const root =
      kind === "formattedTranscript" ||
      kind === "status" ||
      (kind === "media" && job.storageSurface === "content-tree")
        ? destination
        : recordingRoot;
    if (!root || !resolve(path).startsWith(`${resolve(root)}${sep}`)) return [];
    return [{ path, root }];
  });
  let unreadableEvidence = false;
  const availableArtifacts = (
    await Promise.all(
      entries.map(async ({ path, root }) => {
        try {
          await assertMediaArtifactPath(path, root);
          const info = await lstat(path);
          return info.isFile() ? path : null;
        } catch (error) {
          if (error.code !== "ENOENT") unreadableEvidence = true;
          return null;
        }
      }),
    )
  ).filter(Boolean);
  const formattedPresent = availableArtifacts.includes(artifacts.formattedTranscript);
  let changed = false;
  if (formattedPresent && job.formattedSha256) {
    try {
      const content = await readFile(artifacts.formattedTranscript);
      changed = createHash("sha256").update(content).digest("hex") !== job.formattedSha256;
    } catch {
      unreadableEvidence = true;
    }
  }
  let evidence = null;
  if (mediaRoot && isMediaJobComplete(job) && !unreadableEvidence) {
    try {
      evidence = await mediaArtifactEvidenceUpdate(job, { mediaRoot, course: { destination } });
    } catch {
      unreadableEvidence = true;
    }
  }
  const missingTranscript =
    isMediaJobComplete(job) &&
    (!artifacts.rawTranscript ||
      !formattedPresent ||
      (mediaRoot && !availableArtifacts.includes(artifacts.rawTranscript)));
  const invalid =
    unreadableEvidence || changed || missingTranscript || evidence?.complete === false;
  const verified = mediaRoot && isMediaJobComplete(job) && !invalid;
  const artifactIntegrity = verified
    ? "source and derivative digests verified against workflow evidence; speech quality unverified"
    : `queue declaration; visible artifact presence checked${formattedPresent && job.formattedSha256 && !changed ? "; derivative digest checked" : "; derivative ownership/integrity unverified"}; source integrity and speech quality unverified`;
  const media = Object.fromEntries(
    ["video", "audio"].map((kind) => {
      const value = job.media?.[kind];
      return [
        kind,
        value
          ? {
              ...value,
              available: value.available === true && availableArtifacts.includes(value.path),
              availabilityVerified: entries.some(({ path }) => path === value.path),
              declaredAvailable: value.available === true,
            }
          : value,
      ];
    }),
  );
  return {
    ...job,
    availableArtifacts,
    checkedArtifacts: entries.map(({ path }) => path),
    artifactIntegrity,
    media,
    ...(invalid
      ? {
          complete: false,
          stage: "red",
          verdict: "red",
          transcript: { ...job.transcript, complete: false },
          limitations: [
            ...(job.limitations ?? []),
            ...(evidence?.limitations ?? []),
            changed
              ? "Formatted transcript differs from workflow evidence; preserved unchanged. Explicit regeneration or Owner review is required."
              : "Source or formatted transcript evidence is missing or unverified; queue completion is not current file integrity evidence.",
          ],
        }
      : {}),
  };
}
