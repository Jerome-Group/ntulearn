import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runMediaProcess } from "./process.mjs";
import { remuxYoutube } from "./production-remux.mjs";
import { createYoutubeProvider } from "./youtube.mjs";

const HOUR_MS = 60 * 60 * 1_000;

export function createProductionYoutubeProvider(context) {
  return createYoutubeProvider({
    resolveVideo: ({ reference, signal }) => resolveYoutube(reference, signal, context),
    download: (url, options) => downloadYoutube(url, options, context),
    remux: (downloaded, options) => remuxYoutube(downloaded, options, context),
  });
}

async function resolveYoutube(reference, signal, { commands }) {
  const videoId = String(reference ?? "").replace(/^youtube:/, "");
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(videoId)) {
    throw new Error(
      "Unsupported YouTube reference shape. Run media discovery again before retrying the worker.",
    );
  }
  const result = await runMediaProcess(
    commands.ytDlp,
    [
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--skip-download",
      "--dump-single-json",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { signal, timeoutMs: 120_000, label: "YouTube metadata resolution" },
  );
  let metadata;
  try {
    metadata = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      "YouTube metadata was unreadable. Update yt-dlp, then retry the media worker.",
      { cause: error },
    );
  }
  const duration = Number(metadata.duration);
  return {
    ...(Number.isFinite(duration) && duration > 0 ? { duration, speechDuration: duration } : {}),
    media: {
      video: [
        {
          url: `https://www.youtube.com/watch?v=${videoId}`,
          height: Number.isFinite(Number(metadata.height)) ? Number(metadata.height) : null,
          audio: metadata.acodec !== "none",
        },
      ],
    },
  };
}

async function downloadYoutube(url, { signal } = {}, { paths, commands }) {
  const directory = await mkdtemp(join(paths.work, "youtube-download-"));
  try {
    const result = await runMediaProcess(
      commands.ytDlp,
      [
        "--no-playlist",
        "--no-warnings",
        "--format",
        "bestvideo[height<=720][vcodec!=none]+bestaudio[acodec!=none]/best[height<=720][vcodec!=none][acodec!=none]",
        "--merge-output-format",
        "mkv",
        "--output",
        join(directory, "source.%(ext)s"),
        "--print",
        "after_move:filepath",
        url,
      ],
      { signal, timeoutMs: 4 * HOUR_MS, label: "YouTube media download" },
    );
    const path = result.stdout.trim().split(/\r?\n/).at(-1);
    if (!path?.startsWith(`${directory}/`)) {
      throw new Error(
        "YouTube media download produced no local file. Check yt-dlp, then retry the media worker.",
      );
    }
    return { path, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
