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

  assert.match(raw.path, /RAID0[\\/]Media[\\/]recordings[\\/]/);
  assert.equal(formatted.path, join(destination, "01 Lectures/01 Lecture.transcript.md"));
  assert.equal(media.path, join(destination, "01 Lectures/01 Lecture.mp4"));
  assert.equal(await readFile(raw.path, "utf8"), '{"language":"en"}\n');
  assert.equal(await readFile(formatted.path, "utf8"), "# Lecture\n");
  assert.equal(await readFile(media.path, "utf8"), "video");
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
