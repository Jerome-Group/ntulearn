import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaQueuePath } from "../../src/media/queue.mjs";
import { mediaRecordingRoot } from "../../src/media/storage.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function recoveryFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntulearn-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const course = {
    key: "FIXTURE",
    courseId: "_1_1",
    destination: join(root, "course"),
    mediaMode: "active",
  };
  const mediaRoot = join(root, "media");
  const config = {
    statePath: join(root, "state.json"),
    courses: [course],
    media: {
      mediaRoot,
      freeSpaceReserveBytes: 1000,
      setup: {
        mediaTool: { filename: "ffmpeg" },
        asr: {
          runtime: { filename: "whisper", revision: "v1.0.0" },
          model: {
            filename: "asr",
            name: "fixture",
            revision: "revision",
            sha256: digest("model"),
            license: "MIT",
          },
        },
        formatter: {
          runtime: { filename: "llama", revision: "v1.0.0" },
          model: { filename: "formatter", revision: "revision" },
        },
      },
      tools: { ffprobe: "ffprobe" },
    },
  };
  const job = {
    title: "Lecture one: uncertain mathematics",
    recordingId: "content-tree:_1_1:lecture",
    courseId: course.courseId,
    courseKey: course.key,
    disposition: "recording",
    provider: "direct",
    providerReference: "fixture",
    stage: "complete",
    complete: true,
    storageSurface: "content-tree",
    placement: {
      destination: course.destination,
      videoPath: "lecture.mp4",
      formattedTranscriptPath: "lecture.transcript.md",
      statusPath: "lecture.media-status.md",
    },
  };
  const recordingRoot = mediaRecordingRoot(mediaRoot, job.recordingId);
  await mkdir(recordingRoot, { recursive: true });
  await mkdir(course.destination);
  await mkdir(join(root, "media-queue"));
  const source = {
    sourceKind: "generated",
    language: "en",
    segments: [{ start: 0, end: 20, text: "Old source old source old source old source." }],
  };
  const sourceBody = JSON.stringify(source),
    original = "Original student-visible transcript.";
  const sourcePath = join(recordingRoot, "transcript.raw.json"),
    mediaPath = join(course.destination, "lecture.mp4"),
    originalPath = join(course.destination, "lecture.transcript.md");
  const metadataPath = join(recordingRoot, "transcript.metadata.json"),
    statePath = join(recordingRoot, "transcript.state.json"),
    queuePath = mediaQueuePath(config.statePath, course.key);
  const proof = {
    recordingId: job.recordingId,
    sourceSha256: digest(sourceBody),
    formattedSha256: digest(original),
    media: { video: { path: mediaPath, available: true, audio: true } },
  };
  await writeFile(sourcePath, sourceBody);
  await writeFile(mediaPath, "fixture audio");
  await writeFile(originalPath, original);
  await writeFile(metadataPath, JSON.stringify(proof));
  await writeFile(statePath, JSON.stringify({ ...proof, artifacts: { media: mediaPath } }));
  const saveQueue = async (queue = [job]) =>
    writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        courseKey: course.key,
        courseId: course.courseId,
        complete: true,
        queue,
      }),
    );
  await saveQueue();
  const manifest = {
    schemaVersion: 1,
    policy: "independent-context-v1",
    budgets: {
      maxRecordingSeconds: 300,
      maxInputBytes: 100000,
      maxOutputBytes: 1000000,
      jobTimeoutMs: 5000,
      processTimeoutMs: 1000,
    },
    recordings: [
      {
        courseKey: course.key,
        recordingId: job.recordingId,
        source: { path: sourcePath, sha256: digest(sourceBody) },
        media: { path: mediaPath, sha256: digest("fixture audio") },
      },
    ],
  };
  const manifestPath = join(root, "manifest.json"),
    outputDirectory = join(mediaRoot, "fresh-candidates");
  const saveManifest = () => writeFile(manifestPath, JSON.stringify(manifest));
  await saveManifest();
  const addRecording = async () => {
    const secondJob = {
      ...job,
      title: "Lecture two: examples",
      recordingId: "content-tree:_1_1:lecture-two",
      placement: {
        ...job.placement,
        videoPath: "lecture-two.mp4",
        formattedTranscriptPath: "lecture-two.transcript.md",
      },
    };
    const secondRoot = mediaRecordingRoot(mediaRoot, secondJob.recordingId);
    await mkdir(secondRoot);
    const secondSource = join(secondRoot, "transcript.raw.json"),
      secondMedia = join(course.destination, secondJob.placement.videoPath);
    const secondProof = {
      ...proof,
      recordingId: secondJob.recordingId,
      media: { video: { path: secondMedia, available: true, audio: true } },
    };
    await writeFile(secondSource, sourceBody);
    await writeFile(secondMedia, "fixture audio");
    await writeFile(
      join(course.destination, secondJob.placement.formattedTranscriptPath),
      original,
    );
    await writeFile(join(secondRoot, "transcript.metadata.json"), JSON.stringify(secondProof));
    await writeFile(
      join(secondRoot, "transcript.state.json"),
      JSON.stringify({ ...secondProof, artifacts: { media: secondMedia } }),
    );
    await saveQueue([job, secondJob]);
    manifest.recordings.push({
      courseKey: course.key,
      recordingId: secondJob.recordingId,
      source: { path: secondSource, sha256: digest(sourceBody) },
      media: { path: secondMedia, sha256: digest("fixture audio") },
    });
    await saveManifest();
  };
  const calls = [],
    native = { language: "en", segments: [{ start: 0, end: 20, text: "Let x equal minus two." }] };
  const dependencies = {
    volumeRoot: root,
    verifyRuntime: async () => {
      calls.push("runtime");
      return {
        artifacts: [{ key: "asr.model", sha256: digest("model") }],
        runtime: { bin: root, models: root },
      };
    },
    createCapacity: async () => ({ check: async () => calls.push("capacity") }),
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      if (options.label === "Recovery duration probe")
        return { stdout: '{"format":{"duration":"20"}}' };
      if (options.label === "Whisper transcription")
        await writeFile(args[args.indexOf("-of") + 1] + ".json", JSON.stringify(native));
      return { stdout: "", stderr: "" };
    },
  };
  return {
    root,
    config,
    course,
    job,
    manifest,
    manifestPath,
    outputDirectory,
    sourcePath,
    originalPath,
    metadataPath,
    statePath,
    queuePath,
    sourceBody,
    original,
    native,
    calls,
    dependencies,
    saveQueue,
    saveManifest,
    addRecording,
    options: { config, manifestPath, outputDirectory },
  };
}
