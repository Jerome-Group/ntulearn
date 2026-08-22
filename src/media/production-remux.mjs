import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { runMediaProcess } from "./process.mjs";
import { mediaExtension } from "./production-values.mjs";

const HOUR_MS = 60 * 60 * 1_000;

export async function remuxKaltura(downloaded, { signal }, context) {
  const directory = await mkdtemp(join(context.paths.work, "remux-"));
  return remux({
    context,
    input: downloaded.url,
    output: join(directory, "recording.mp4"),
    filename: "recording.mp4",
    argumentsFor: ["-c", "copy", "-movflags", "+faststart"],
    directory,
    signal,
    label: "Kaltura HLS remux",
  });
}

export async function remuxDirect(downloaded, { signal, representation }, context) {
  if (downloaded.retained) {
    return {
      path: downloaded.path,
      filename: basename(downloaded.path),
      audio: representation?.kind === "audio" || representation?.audio !== false,
    };
  }
  const directory = downloaded.path.slice(0, downloaded.path.lastIndexOf("/"));
  const extension = mediaExtension({ url: downloaded.path, kind: representation?.kind });
  return remux({
    context,
    input: downloaded.path,
    output: join(directory, `recording${extension}`),
    filename: `recording${extension}`,
    argumentsFor: [
      "-c",
      "copy",
      ...([".mp4", ".m4a"].includes(extension) ? ["-movflags", "+faststart"] : []),
    ],
    directory,
    signal,
    label: "Direct media remux",
  });
}

export async function remuxYoutube(downloaded, { signal }, context) {
  const directory = await mkdtemp(join(context.paths.work, "youtube-remux-"));
  return remux({
    context,
    input: downloaded.path,
    output: join(directory, "recording.mp4"),
    filename: "recording.mp4",
    argumentsFor: ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    directory,
    extraDirectory: downloaded.directory,
    signal,
    label: "YouTube media remux",
  });
}

export async function probeMediaDuration(input, signal, { commands }) {
  const result = await runMediaProcess(
    commands.ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ],
    { signal, timeoutMs: 60_000, label: "Direct media duration probe" },
  );
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      "Direct media duration was not exposed. Check ffprobe, then retry the media worker.",
    );
  }
  return duration;
}

async function remux({
  context,
  input,
  output,
  filename,
  argumentsFor,
  directory,
  extraDirectory,
  signal,
  label,
}) {
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
    if (extraDirectory) await rm(extraDirectory, { recursive: true, force: true });
  };
  try {
    await runMediaProcess(context.commands.ffmpeg, ["-y", "-i", input, ...argumentsFor, output], {
      signal,
      timeoutMs: 4 * HOUR_MS,
      label,
    });
    return { path: output, filename, audio: true, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
