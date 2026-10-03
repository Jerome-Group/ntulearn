import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionJobRunner } from "../src/media/production.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";

function group(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("actual production composition formats provider wording without starting llama or ASR", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-production-paragraph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"),
    work = join(root, "work"),
    models = join(root, "models"),
    destination = join(root, "course");
  for (const path of [bin, work, models, destination]) await mkdir(path);
  const marker = join(root, "model-started");
  await writeFile(
    join(bin, "ffmpeg"),
    `#!${process.execPath}\nrequire('fs').writeFileSync(process.argv.at(-1),'owned synthetic media');\n`,
    { mode: 0o700 },
  );
  for (const filename of ["llama", "whisper"])
    await writeFile(
      join(bin, filename),
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'model started');process.exit(1);\n`,
      { mode: 0o700 },
    );
  const native =
    "WEBVTT\n\n00:00.000 --> 00:20.000\n<v Teacher>Maybe x = -2; 中文 and literal 00:01 remain uncertain.\n";
  let observe;
  const page = {
    on: (_name, callback) => {
      observe = callback;
    },
    off: () => {},
    goto: async () => {
      observe({
        url: () => "https://synthetic.invalid/playManifest",
        text: async () => "https://synthetic.invalid/index.m3u8",
      });
      observe({ url: () => "https://synthetic.invalid/caption.vtt", text: async () => native });
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (selector) =>
      selector === "body"
        ? { innerText: async () => "0:00 / 0:20" }
        : { first: () => ({ count: async () => 0 }) },
  };
  const model = {
    name: "owned",
    revision: "owned",
    sha256: "a".repeat(64),
    license: "owned",
    filename: "owned",
  };
  const setup = {
    mediaTool: { filename: "ffmpeg" },
    asr: { runtime: { filename: "whisper", revision: "owned" }, model },
    formatter: { runtime: { filename: "llama", revision: "owned" }, model },
  };
  const runner = await createProductionJobRunner({
    config: {
      profilePath: join(root, "never-opened-profile"),
      media: {
        mediaRoot: join(root, "media"),
        setup,
        tools: { ffprobe: "unused", ytDlp: "unused" },
      },
    },
    runtime: { runtime: { bin, work, models } },
    capacity: { check: async () => {} },
    signalProcessGroup: group,
    createStorage: (options) => createMediaStorage({ ...options, volumeRoot: root }),
    open: async () => ({ withBrowserPage: (callback) => callback(page), close: async () => {} }),
  });
  t.after(() => runner.close());
  const result = await runner.run(
    {
      recordingId: "owned-production",
      provider: "kaltura",
      providerReference: "entry:owned",
      sourceKind: "media-gallery",
      storageSurface: "media-gallery",
      title: "Owned",
      placement: {
        destination,
        formattedTranscriptPath: "Owned.md",
        statusPath: "Owned.status.md",
      },
    },
    {},
  );
  assert.equal(result.complete, true);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const metadata = JSON.parse(await readFile(result.artifacts.metadata.path, "utf8"));
  assert.equal(metadata.formatterVersion, "source-paragraphs-v1");
  assert.equal(await readFile(result.artifacts.providerTranscript.path, "utf8"), native);
  assert.match(
    await readFile(result.artifacts.formattedTranscript.path, "utf8"),
    /\[Teacher\] Maybe x = -2; 中文 and literal 00:01 remain uncertain\./,
  );
});
