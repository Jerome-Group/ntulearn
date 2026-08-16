import { resolve, sep } from "node:path";
import { writeAtomically } from "../atomic.mjs";
import { isMediaJobComplete } from "./completeness.mjs";
import { publicMediaError } from "./errors.mjs";

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
}) {
  if (!course?.destination) return null;
  const status = mediaCourseStatus({ course, discovery, queue, now });
  const path = mediaCourseStatusPath(course);
  await write(path, `${courseStatusMarkdown(status)}\n`);
  return { path, status: "written", verdict: status.verdict };
}

export async function writeMediaRecordingStatus({
  appearance,
  job = appearance,
  now = () => new Date(),
  write = writeAtomically,
}) {
  const path = mediaRecordingStatusPath(appearance);
  if (!path) return null;
  const status = mediaRecordingStatus({ appearance, job, now });
  await write(path, `${recordingStatusMarkdown(status)}\n`);
  return { path, status: "written", verdict: status.verdict };
}

export function mediaRecordingStatus({ appearance = {}, job = {}, now = () => new Date() }) {
  const withdrawn = job.withdrawn === true || job.stage === "withdrawn";
  const declaredComplete = job.complete === true || job.stage === "complete";
  const media = normalizedMedia(job.media);
  const transcript = normalizedTranscript(job.transcript);
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
  const stage = withdrawn ? "withdrawn" : (job.stage ?? (complete ? "complete" : "queued"));
  const verdict = withdrawn
    ? "green"
    : declaredComplete && !complete
      ? "red"
      : (job.verdict ?? (complete ? (limitations.length ? "yellow" : "green") : "yellow"));

  return {
    recordingId: job.recordingId ?? appearance.recordingId ?? null,
    title: cleanText(job.title ?? appearance.title ?? "Untitled recording"),
    provider: job.providerName ?? job.provider ?? appearance.provider ?? "unknown",
    sourceKind: job.sourceKind ?? appearance.sourceKind ?? "unknown",
    stage,
    verdict,
    complete,
    retryable: withdrawn ? false : job.retryable !== false,
    transcript,
    media,
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
      else if (recording.complete) counts.complete += 1;
      else if (recording.verdict === "red" || recording.stage === "failed") counts.failed += 1;
      else if (recording.stage === "active") counts.active += 1;
      else if (recording.stage === "checkpointed") counts.checkpointed += 1;
      else counts.queued += 1;
      return counts;
    },
    { total: 0, complete: 0, queued: 0, active: 0, checkpointed: 0, failed: 0, withdrawn: 0 },
  );
}

function courseVerdict({ course, discovery, recordings, counts }) {
  if (course?.mediaMode === "off") return "green";
  if (discovery.complete !== true || discovery.verdict === "red") return "red";
  if (counts.failed || recordings.some((recording) => recording.verdict === "red")) return "red";
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
    `- Recordings: ${status.counts.total}`,
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
    `- Provider: ${displayName(recording.provider)}`,
    `- Source: ${cleanText(recording.sourceKind)}`,
    `- Stage: ${recording.stage}`,
    `- Verdict: ${recording.verdict}`,
    `- Video: ${mediaAvailability(recording.media.video)}`,
    `- Audio: ${mediaAvailability(recording.media.audio)}`,
    `- Transcript provenance: ${recording.transcript.provenance}`,
    `- Retryable: ${recording.retryable ? "yes" : "no"}`,
    `- Attempts: ${recording.attempts}`,
    `- Limitations: ${recording.limitations.length ? recording.limitations.join(" ") : "None"}`,
    ...(recording.lastError ? [`- Last error: ${recording.lastError}`] : []),
    `- Updated: ${recording.updatedAt}`,
  ];
}

function mediaAvailability(value) {
  return value.available
    ? `available${value.quality ? ` (${value.quality}p)` : ""}`
    : "unavailable";
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
