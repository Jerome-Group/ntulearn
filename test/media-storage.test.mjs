import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMediaStorage } from "../src/media/storage.mjs";

test("keeps source artifacts in Media and visible content-tree derivatives beside the item", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const destination = join(root, "course");
  await mkdir(mediaRoot, { recursive: true });
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  const appearance = {
    recordingId: "content-tree:_9_1:item-1:entry:lecture",
    storageSurface: "content-tree",
    placement: {
      destination,
      directorySegments: ["01 Lectures"],
      videoPath: "01 Lectures/01 Lecture.mp4",
      audioPath: "01 Lectures/01 Lecture.m4a",
      formattedTranscriptPath: "01 Lectures/01 Lecture.transcript.md",
      statusPath: "01 Lectures/01 Lecture.media-status.md",
      videoAlreadyPresent: false,
    },
  };

  const raw = await storage.write({
    appearance,
    kind: "raw-transcript",
    content: '{"language":"en"}\n',
  });
  const provider = await storage.write({
    appearance,
    kind: "provider-transcript",
    filename: "https://video.example.test/captions.json?ks=session-secret",
    content: "captions",
  });
  const formatted = await storage.write({
    appearance,
    kind: "formatted-transcript",
    content: "# Lecture\n",
  });
  const media = await storage.write({
    appearance,
    kind: "media",
    mediaKind: "video",
    filename: "lecture.mp4",
    content: Buffer.from("video"),
  });
  const audio = await storage.write({
    appearance,
    kind: "media",
    mediaKind: "audio",
    filename: "lecture.m4a",
    content: Buffer.from("audio"),
  });

  assert.match(raw.path, /RAID0[\\/]Media[\\/]recordings[\\/]/);
  assert.equal(provider.path.endsWith("/provider/captions.json"), true);
  assert.doesNotMatch(provider.path, /session-secret|https?:/);
  assert.equal(formatted.path, join(destination, "01 Lectures/01 Lecture.transcript.md"));
  assert.equal(media.path, join(destination, "01 Lectures/01 Lecture.mp4"));
  assert.equal(audio.path, join(destination, "01 Lectures/01 Lecture.m4a"));
  assert.equal(await readFile(raw.path, "utf8"), '{"language":"en"}\n');
  assert.equal(await readFile(formatted.path, "utf8"), "# Lecture\n");
  assert.equal(await readFile(media.path, "utf8"), "video");
  assert.equal(await readFile(audio.path, "utf8"), "audio");
});

test("copies a file-backed media artifact atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-file-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const destination = join(root, "course");
  const sourcePath = join(root, "runtime", "recording.mp4");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(sourcePath, "file-backed video");
  const storage = createMediaStorage({ mediaRoot, volumeRoot });

  const result = await storage.write({
    appearance: {
      recordingId: "media-gallery:_9_1:gallery-file",
      storageSurface: "media-gallery",
      placement: {
        destination,
        videoPath: "Media Gallery/Lecture.mp4",
      },
    },
    kind: "media",
    mediaKind: "video",
    sourcePath,
    filename: "Lecture.mp4",
  });

  assert.equal(result.status, "written");
  assert.equal(await readFile(result.path, "utf8"), "file-backed video");
});

test("does not replace a video attachment that already supplies the content-tree sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const target = join(root, "course/01 Lectures/01 Lecture.mp4");
  await mkdir(join(root, "course/01 Lectures"), { recursive: true });
  await writeFile(target, "student-owned video");
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  const result = await storage.write({
    appearance: {
      recordingId: "content-tree:item",
      placement: {
        destination: join(root, "course"),
        videoPath: "01 Lectures/01 Lecture.mp4",
        videoAlreadyPresent: true,
      },
    },
    kind: "media",
    mediaKind: "video",
    content: Buffer.from("do not replace"),
  });

  assert.deepEqual(result, { path: target, status: "existing" });
  assert.equal(await readFile(target, "utf8"), "student-owned video");
});

test("does not trust an attachment flag when the visible video is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const target = join(root, "course/01 Lectures/01 Lecture.mp4");
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  const result = await storage.write({
    appearance: {
      recordingId: "content-tree:item",
      placement: {
        destination: join(root, "course"),
        videoPath: "01 Lectures/01 Lecture.mp4",
        videoAlreadyPresent: true,
      },
    },
    kind: "media",
    mediaKind: "video",
    content: Buffer.from("downloaded video"),
  });

  assert.deepEqual(result, { path: target, status: "written" });
  assert.equal(await readFile(target, "utf8"), "downloaded video");
});

test("keeps successful transcript artifacts write-once and reads them at the storage seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  const appearance = {
    recordingId: "content-tree:item",
    placement: {
      destination: join(root, "course"),
      videoPath: "01 Lecture/01 Lecture.mp4",
      formattedTranscriptPath: "01 Lecture/01 Lecture.transcript.md",
      statusPath: "01 Lecture/01 Lecture.media-status.md",
    },
  };

  const first = await storage.write({
    appearance,
    kind: "raw-transcript",
    content: '{"sourceKind":"generated"}\n',
  });
  const second = await storage.write({
    appearance,
    kind: "raw-transcript",
    content: '{"sourceKind":"provider"}\n',
  });
  const read = await storage.read({ appearance, kind: "raw-transcript" });

  assert.deepEqual(second, { path: first.path, status: "existing" });
  await assert.rejects(
    storage.write({
      appearance,
      kind: "raw-transcript",
      content: "replace",
      replace: true,
    }),
    /proof-bearing formatted transcript/i,
  );
  assert.equal(read.path, first.path);
  assert.equal(read.content.toString(), '{"sourceKind":"generated"}\n');
});

test("keeps Media Gallery media in the Media store and visible derivatives in the course", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-gallery-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const destination = join(root, "course");
  await mkdir(mediaRoot, { recursive: true });
  const storage = createMediaStorage({ mediaRoot, volumeRoot });
  const appearance = {
    recordingId: "media-gallery:_9_1:gallery-1",
    storageSurface: "media-gallery",
    placement: {
      destination,
      videoPath: "Media Gallery/2026-08-10 09-00-00 Lecture.mp4",
      audioPath: "Media Gallery/2026-08-10 09-00-00 Lecture.m4a",
      formattedTranscriptPath: "Media Gallery/2026-08-10 09-00-00 Lecture.transcript.md",
      statusPath: "Media Gallery/2026-08-10 09-00-00 Lecture.media-status.md",
    },
  };

  const media = await storage.write({
    appearance,
    kind: "media",
    mediaKind: "video",
    filename: "lecture.mp4",
    content: Buffer.from("video"),
  });
  const formatted = await storage.write({
    appearance,
    kind: "formatted-transcript",
    content: "# Lecture\n",
  });
  const status = await storage.write({
    appearance,
    kind: "status",
    content: "# Status\n",
  });

  assert.match(media.path, /RAID0[\\/]Media[\\/]recordings[\\/].+[\\/]media[\\/]lecture\.mp4$/);
  assert.equal(formatted.path, join(destination, appearance.placement.formattedTranscriptPath));
  assert.equal(status.path, join(destination, appearance.placement.statusPath));
  assert.equal(await readFile(media.path, "utf8"), "video");
});

test("marks storage-capacity failures as global media safety errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });
  const storage = createMediaStorage({
    mediaRoot,
    volumeRoot,
    async write() {
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    },
  });

  await assert.rejects(
    storage.write({
      appearance: {
        recordingId: "content-tree:item",
        placement: { destination: join(root, "course"), formattedTranscriptPath: "lecture.md" },
      },
      kind: "formatted-transcript",
      content: "# Lecture\n",
    }),
    (error) => error.globalSafety === true && error.code === "ENOSPC",
  );
});
