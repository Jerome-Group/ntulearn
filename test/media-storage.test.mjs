import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("rejects symlinked artifact ancestors before writing outside its store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-escape-"));
  try {
    const volumeRoot = join(root, "RAID0");
    const mediaRoot = join(volumeRoot, "Media");
    const outside = join(root, "outside");
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(mediaRoot, "recordings"));
    const storage = createMediaStorage({ mediaRoot, volumeRoot });
    await assert.rejects(
      storage.write({
        appearance: { recordingId: "fixture" },
        kind: "raw-transcript",
        content: "fixture",
      }),
      /symlink|outside/i,
    );
    await assert.rejects(readFile(join(outside, "transcript.raw.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked course artifact directory and preserves user edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-course-escape-"));
  try {
    const volumeRoot = join(root, "RAID0");
    const mediaRoot = join(volumeRoot, "Media");
    const destination = join(root, "course");
    const outside = join(root, "outside");
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(destination);
    await mkdir(outside);
    await writeFile(join(outside, "Lecture.transcript.md"), "user edit");
    await symlink(outside, join(destination, "Lectures"));
    const storage = createMediaStorage({ mediaRoot, volumeRoot });
    const appearance = {
      recordingId: "fixture",
      placement: { destination, formattedTranscriptPath: "Lectures/Lecture.transcript.md" },
    };
    await assert.rejects(
      storage.write({ appearance, kind: "formatted-transcript", content: "replacement" }),
      /symlink/i,
    );
    assert.equal(await readFile(join(outside, "Lecture.transcript.md"), "utf8"), "user edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an oversized promotion before copying and retains the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-reserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  await mkdir(mediaRoot);
  const sourcePath = join(root, "scratch.mp4");
  await writeFile(sourcePath, "synthetic media");
  const appearance = {
    recordingId: "reserve-fixture",
    storageSurface: "media-gallery",
    placement: {},
  };
  let copied = false;
  const storage = createMediaStorage({
    mediaRoot,
    volumeRoot: root,
    checkCapacity: async ({ bytes }) => {
      assert.equal(bytes, 15);
      const error = new Error("Insufficient reserve for promotion.");
      error.globalSafety = true;
      throw error;
    },
    write: async () => {
      copied = true;
    },
  });
  await assert.rejects(
    storage.write({ appearance, kind: "media", sourcePath, filename: "fixture.mp4" }),
    /reserve/,
  );
  assert.equal(copied, false);
  assert.equal(await readFile(sourcePath, "utf8"), "synthetic media");
  assert.equal(await storage.read({ appearance, kind: "media", filename: "fixture.mp4" }), null);
});

test("rechecks reserve at promotion and preserves the previous owned artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-promotion-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  await mkdir(mediaRoot);
  const appearance = { recordingId: "promotion", storageSurface: "media-gallery", placement: {} };
  const initial = createMediaStorage({ mediaRoot, volumeRoot: root });
  const held = await initial.write({ appearance, kind: "metadata", content: "original" });
  let writing = false;
  const checked = [];
  const storage = createMediaStorage({
    mediaRoot,
    volumeRoot: root,
    checkCapacity: async ({ bytes = 0 }) => {
      checked.push(bytes);
      if (writing) {
        const error = new Error("Reserve depleted during artifact write. Free space, then retry.");
        error.globalSafety = true;
        throw error;
      }
    },
    write: async (path, content) => {
      await writeFile(path, content);
      writing = true;
    },
  });
  await assert.rejects(
    storage.write({ appearance, kind: "metadata", content: "updated" }),
    /Reserve depleted/,
  );
  assert.deepEqual(checked, [7, 0]);
  assert.equal(await readFile(held.path, "utf8"), "original");
  assert.deepEqual(await readdir(dirname(held.path)), ["transcript.metadata.json"]);
});

test("bounds unresolved prewrite and promotion guards without replacing held artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-storage-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "Media");
  await mkdir(mediaRoot);
  const appearance = { recordingId: "deadline", storageSurface: "media-gallery", placement: {} };
  const held = await createMediaStorage({ mediaRoot, volumeRoot: root }).write({
    appearance,
    kind: "metadata",
    content: "original",
  });
  let phase = "prewrite";
  let releaseLate;
  const storage = createMediaStorage({
    mediaRoot,
    volumeRoot: root,
    capacityCheckTimeoutMs: 10,
    checkCapacity: ({ bytes = 0 }) =>
      phase === "prewrite" || (phase === "promotion" && bytes === 0)
        ? new Promise((resolve) => {
            releaseLate = resolve;
          })
        : Promise.resolve(),
  });
  for (const blocked of ["prewrite", "promotion"]) {
    phase = blocked;
    await assert.rejects(
      Promise.race([
        storage.write({ appearance, kind: "metadata", content: "updated" }),
        new Promise((_, reject) =>
          globalThis.setTimeout(() => reject(new Error("fixture exceeded bound")), 150),
        ),
      ]),
      (error) => error.globalSafety === true && /timed out.*retry/.test(error.message),
    );
    releaseLate();
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(await readFile(held.path, "utf8"), "original");
    assert.deepEqual(await readdir(dirname(held.path)), ["transcript.metadata.json"]);
  }
  phase = "responsive";
  await storage.write({ appearance, kind: "metadata", content: "recovered" });
  assert.equal(await readFile(held.path, "utf8"), "recovered");
});
