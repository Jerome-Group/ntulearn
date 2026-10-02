import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaRecordingRoot } from "../../src/media/storage.mjs";
import { historicalDigest } from "../../src/media/historical-files.mjs";
import { mediaQueuePath } from "../../src/media/queue.mjs";
import { createMediaCapacity } from "../../src/media/capacity.mjs";
export async function historicalFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-historical-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course"),
    disabled = join(root, "disabled"),
    mediaRoot = join(root, "media"),
    statePath = join(root, "state.json");
  await mkdir(destination);
  await mkdir(disabled);
  await mkdir(mediaRoot);
  const config = {
    statePath,
    media: { mediaRoot, freeSpaceReserveBytes: 1 },
    courses: [
      { key: "course", courseId: "synthetic-course", destination, mediaMode: "active" },
      { key: "disabled", courseId: "disabled-course", destination: disabled, mediaMode: "off" },
    ],
  };
  const recordingId = "content-tree:synthetic-course:item:entry:stable";
  const recordRoot = mediaRecordingRoot(mediaRoot, recordingId);
  await mkdir(join(recordRoot, "provider"), { recursive: true });
  const raw =
    JSON.stringify({
      sourceKind: "provider",
      language: "en",
      segments: [
        { start: 0, end: 1, text: "First source words" },
        { start: 1, end: 2, text: "Second 42 中文 + words" },
      ],
    }) + "\n";
  const original = "Wrong formatter invented summary\n";
  const sourcePath = join(recordRoot, "transcript.raw.json"),
    originalPath = join(destination, "Lecture.transcript.md"),
    metadataPath = join(recordRoot, "transcript.metadata.json");
  await writeFile(sourcePath, raw);
  await writeFile(originalPath, original);
  await writeFile(join(destination, "student.md"), "Student untouched bytes");
  await writeFile(
    join(recordRoot, "provider", "captions.vtt"),
    "WEBVTT\n\n00:00.000 --> 00:01.000\nFirst source words\n",
  );
  const metadata = {
    recordingId,
    sourceSha256: historicalDigest(raw),
    formattedSha256: historicalDigest(original),
    duration: 2,
    recordingReference: "entry:stable",
  };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const job = {
    recordingId,
    courseId: "synthetic-course",
    courseKey: "course",
    title: "Lecture",
    providerReference: "entry:stable",
    placement: {
      destination,
      formattedTranscriptPath: "Lecture.transcript.md",
      statusPath: "Lecture.media-status.md",
    },
  };
  const queuePath = mediaQueuePath(statePath, "course");
  await mkdir(join(root, "media-queue"));
  await writeFile(
    queuePath,
    JSON.stringify({ courseKey: "course", courseId: "synthetic-course", queue: [job] }),
  );
  const dependencies = {
    createCapacity: (media, options) =>
      createMediaCapacity(media, { ...options, volumeRoot: root }),
  };
  return {
    root,
    config,
    dependencies,
    recordRoot,
    sourcePath,
    originalPath,
    metadataPath,
    metadata,
    job,
    queuePath,
    raw,
    original,
    manifestPath: join(root, "plan.json"),
  };
}
