import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { setupMediaRuntime, verifyMediaRuntime } from "../src/media/setup.mjs";

test("prepares all selected runtimes and models under the Media store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const sourceRoot = join(root, "sources");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  const sources = {
    ffmpeg: await source(sourceRoot, "ffmpeg", "ffmpeg 1\n", true),
    whisperRuntime: await source(sourceRoot, "whisper-cli", "whisper 1\n", true),
    whisperModel: await source(sourceRoot, "whisper.bin", "whisper model\n"),
    formatterRuntime: await source(sourceRoot, "llama-cli", "llama 1\n", true),
    formatterModel: await source(sourceRoot, "formatter.gguf", "formatter model\n"),
  };
  const mediaTool = artifact("FFmpeg", "ffmpeg", "runtime", sources.ffmpeg);
  mediaTool.source = { kind: "url", value: "https://example.test/ffmpeg" };
  const media = {
    mediaRoot,
    freeSpaceReserveBytes: 100 * 1024 ** 3,
    setup: {
      mediaTool,
      asr: {
        runtime: artifact("whisper.cpp", "whisper-cli", "runtime", sources.whisperRuntime),
        model: artifact("Whisper small.en", "ggml-small.en.bin", "model", sources.whisperModel),
      },
      formatter: {
        runtime: artifact("llama.cpp", "llama-cli", "runtime", sources.formatterRuntime),
        model: artifact("Qwen3 1.7B", "Qwen3-1.7B-Q4_K_M.gguf", "model", sources.formatterModel),
      },
    },
  };
  const fetcher = async (url) => {
    assert.equal(url, "https://example.test/ffmpeg");
    return {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => Buffer.from("ffmpeg 1\n"),
    };
  };

  const result = await setupMediaRuntime(media, {
    volumeRoot,
    freeBytes: 200 * 1024 ** 3,
    commandRunner: async () => ({ code: 0 }),
    fetcher,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

  assert.equal(manifest.artifacts.length, 5);
  assert.deepEqual(
    manifest.artifacts.map(({ key }) => key),
    ["mediaTool", "asr.runtime", "asr.model", "formatter.runtime", "formatter.model"],
  );
  assert.equal(manifest.artifacts[0].identity, "FFmpeg");
  assert.equal(manifest.artifacts[0].license, "LGPL-2.1-or-later");
  assert.match(manifest.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(
    manifest.artifacts.every(({ path }) => path.startsWith("bin/") || path.startsWith("models/")),
  );
  assert.deepEqual(await readdir(result.runtime.temp), []);

  await setupMediaRuntime(media, {
    volumeRoot,
    freeBytes: 200 * 1024 ** 3,
    commandRunner: async () => ({ code: 0 }),
    fetcher,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  });
  assert.deepEqual(await readdir(result.runtime.temp), []);

  let installed = false;
  const verified = await verifyMediaRuntime(media, {
    volumeRoot,
    freeBytes: 200 * 1024 ** 3,
    commandRunner: async () => {
      installed = true;
      return { code: 0 };
    },
  });
  assert.equal(verified.manifestPath, result.manifestPath);
  assert.equal(installed, false);
});

test("rejects a missing RAID0 Media store before creating runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(volumeRoot);

  await assert.rejects(
    setupMediaRuntime(
      { mediaRoot, freeSpaceReserveBytes: 100, setup: minimalSetup() },
      { volumeRoot, freeBytes: 200 },
    ),
    /Media store is unavailable.*npm run media:setup/,
  );
  await assert.rejects(stat(join(mediaRoot, ".runtime")), { code: "ENOENT" });
});

test("rejects an unsafe Media store before creating runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-"));
  const volumeRoot = join(root, "RAID0");
  await mkdir(volumeRoot);
  const mediaRoot = join(root, "system", "Media");

  await assert.rejects(
    setupMediaRuntime(
      { mediaRoot, freeSpaceReserveBytes: 100, setup: minimalSetup() },
      { volumeRoot },
    ),
    /media\.mediaRoot must be a directory below/,
  );
  await assert.rejects(stat(mediaRoot), { code: "ENOENT" });
});

test("rejects low free space before creating runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  await mkdir(mediaRoot, { recursive: true });

  await assert.rejects(
    setupMediaRuntime(
      { mediaRoot, freeSpaceReserveBytes: 100 * 1024 ** 3, setup: minimalSetup() },
      { volumeRoot, freeBytes: 100 * 1024 ** 3 - 1 },
    ),
    /must keep 100\.0 GiB free/,
  );
  await assert.rejects(stat(join(mediaRoot, ".runtime")), { code: "ENOENT" });
});

test("rejects a runtime symlink before creating artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-media-"));
  const volumeRoot = join(root, "RAID0");
  const mediaRoot = join(volumeRoot, "Media");
  const outside = join(root, "outside");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(mediaRoot, ".runtime"));

  await assert.rejects(
    setupMediaRuntime(
      { mediaRoot, freeSpaceReserveBytes: 100, setup: minimalSetup() },
      { volumeRoot, freeBytes: 200 },
    ),
    /Media runtime path is a symlink/,
  );
  assert.deepEqual(await readdir(outside), []);
});

async function source(root, filename, body, executable = false) {
  const path = join(root, filename);
  await writeFile(path, body);
  if (executable) await chmod(path, 0o755);
  return { path, sha256: digest(body) };
}

function artifact(name, filename, kind, source) {
  return {
    kind,
    name,
    source: { kind: "file", value: source.path },
    revision: "r1",
    sha256: source.sha256,
    license: name === "FFmpeg" ? "LGPL-2.1-or-later" : "MIT",
    filename,
    verifyArgs: ["--version"],
  };
}

function minimalSetup() {
  const source = { kind: "file", value: "/missing/source", sha256: "a".repeat(64) };
  const runtime = (name, filename) => ({
    kind: "runtime",
    name,
    source,
    revision: "r1",
    sha256: source.sha256,
    license: "MIT",
    filename,
    verifyArgs: ["--version"],
  });
  const model = (name, filename) => ({ ...runtime(name, filename), kind: "model" });
  return {
    mediaTool: runtime("FFmpeg", "ffmpeg"),
    asr: { runtime: runtime("whisper.cpp", "whisper-cli"), model: model("Whisper", "whisper.bin") },
    formatter: {
      runtime: runtime("llama.cpp", "llama-cli"),
      model: model("Qwen3", "formatter.gguf"),
    },
  };
}

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}
