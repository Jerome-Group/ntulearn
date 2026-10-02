import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionYoutubeProvider } from "../src/media/production-youtube.mjs";
import { createProductionKalturaProvider } from "../src/media/production-kaltura.mjs";
import {
  assertFormattedTranscript,
  parseProviderTranscript,
  rawTranscriptJson,
} from "../src/media/transcript.mjs";
import { runMediaJob } from "../src/media/job.mjs";
import { createMediaStorage } from "../src/media/storage.mjs";
import { runMediaProcess } from "../src/media/process.mjs";

const BODY =
  "WEBVTT\n\n00:00.000 --> 00:10.000\n<v Lecturer>A &amp; B <i>are</i> equal: x_1 &lt; 2.</v>\n";

async function youtube(metadata, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-caption-ingestion-"));
  const executable = join(root, "metadata");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(metadata))});\n`,
  );
  await chmod(executable, 0o700);
  return createProductionYoutubeProvider({
    commands: { ytDlp: executable },
    runProcess: (command, args, settings) =>
      runMediaProcess(command, args, { ...settings, signalProcessGroup }),
    ...options,
  });
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("production captions prefer deterministic manual VTT and fetch separately from video", async () => {
  const calls = [];
  const provider = await youtube(
    {
      duration: 10,
      language: "zh-SG",
      subtitles: {
        en: [{ ext: "vtt", url: "https://fixture.invalid/en?sig=secret" }],
        "zh-SG": [{ ext: "vtt", url: "https://fixture.invalid/zh?sig=secret" }],
      },
      automatic_captions: {
        "zh-SG": [{ ext: "vtt", url: "https://fixture.invalid/auto?sig=secret" }],
      },
    },
    {
      captionFetch: async (url) => {
        calls.push(url);
        return new globalThis.Response(BODY);
      },
    },
  );
  const resolved = await provider.resolve({ providerReference: "youtube:fixture123" });
  assert.equal(resolved.speechDuration, undefined);
  const transcript = await provider.transcript(resolved);
  assert.deepEqual(calls, ["https://fixture.invalid/zh?sig=secret"]);
  assert.equal(transcript.body, BODY);
  const normalized = parseProviderTranscript(transcript);
  assert.equal(normalized.language, "zh-SG");
  assert.deepEqual(normalized.captionProvenance, {
    kind: "manual",
    language: "zh-SG",
    format: "vtt",
  });
  assert.doesNotMatch(rawTranscriptJson(normalized), /https:|sig=|secret/);
});

test("unsupported manual tracks fall back to automatic VTT with truthful provenance", async () => {
  const provider = await youtube(
    {
      duration: 10,
      subtitles: { en: [{ ext: "json3", url: "https://fixture.invalid/manual" }] },
      automatic_captions: { en: [{ ext: "vtt", url: "https://fixture.invalid/auto" }] },
    },
    { captionFetch: async () => new globalThis.Response(BODY) },
  );
  const transcript = await provider.transcript(
    await provider.resolve({ providerReference: "youtube:fixture123" }),
  );
  assert.equal(parseProviderTranscript(transcript).captionProvenance.kind, "automatic");
});

test("VTT normalization preserves explicit voices, technical text and timing", () => {
  const parsed = parseProviderTranscript({ body: BODY });
  assert.deepEqual(parsed.segments, [
    { start: 0, end: 10, text: "[Lecturer] A & B are equal: x_1 < 2." },
  ]);
  assert.equal(parsed.language, "und");
  assert.equal(
    assertFormattedTranscript(parsed.segments[0].text, parsed.segments).trim(),
    parsed.segments[0].text,
  );
  assert.throws(
    () => assertFormattedTranscript("A & B are equal: x_1 < 2.", parsed.segments),
    /lexical/,
  );
  assert.throws(
    () => assertFormattedTranscript("[Professor] A & B are equal: x_1 < 2.", parsed.segments),
    /lexical/,
  );
});

test("Kaltura does not invent measured speech duration or caption language", async () => {
  let onResponse;
  const page = {
    on: (_event, handler) => {
      onResponse = handler;
    },
    off: () => {},
    goto: async () => {
      await onResponse({
        url: () => "https://fixture.invalid/playManifest",
        text: async () => "https://fixture.invalid/index.m3u8",
      });
      await onResponse({
        url: () => "https://fixture.invalid/caption.vtt?ks=secret",
        text: async () => BODY,
      });
    },
    waitForLoadState: async () => {},
    locator: (selector) =>
      selector === "body"
        ? { innerText: async () => "00:00 / 00:10" }
        : { first: () => ({ count: async () => 0 }) },
  };
  const provider = createProductionKalturaProvider(page, {});
  const resolved = await provider.resolve({ providerReference: "entry:fixture" });
  assert.equal(resolved.duration, 10);
  assert.equal(resolved.speechDuration, undefined);
  assert.equal(resolved.transcript.language, "und");
  assert.equal(resolved.transcript.body, BODY);
});

async function jobFixture(captionFetch) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-caption-job-"));
  const production = await youtube(
    {
      duration: 10,
      subtitles: { en: [{ ext: "vtt", url: "https://fixture.invalid/caption?sig=secret" }] },
    },
    { captionFetch },
  );
  const appearance = {
    recordingId: "youtube:fixture123",
    providerReference: "youtube:fixture123",
    storageSurface: "media-gallery",
    placement: {
      destination: join(root, "course"),
      formattedTranscriptPath: "Lecture.transcript.md",
      statusPath: "Lecture.media-status.md",
    },
  };
  return {
    appearance,
    storage: createMediaStorage({ mediaRoot: join(root, "Media"), volumeRoot: root }),
    provider: {
      ...production,
      media: async () => ({ kind: "video", body: Buffer.from("synthetic media"), audio: true }),
    },
    formatter: {
      version: "fixture",
      format: async ({ segments }) => segments.map(({ text }) => text).join("\n\n"),
    },
  };
}

test("production captions avoid ASR and preserve original/provenance across repeats and user edits", async () => {
  let fetched = 0,
    transcribed = 0;
  const options = await jobFixture(async () => {
    fetched++;
    return new globalThis.Response(BODY);
  });
  options.transcriber = {
    transcribe: async () => {
      transcribed++;
      throw new Error("provider captions must avoid ASR");
    },
  };
  const first = await runMediaJob(options);
  assert.equal(first.complete, true);
  assert.equal(transcribed, 0);
  const original = await readFile(first.artifacts.providerTranscript.path, "utf8");
  const raw = await readFile(first.artifacts.rawTranscript.path, "utf8");
  assert.equal(original, BODY);
  assert.equal(JSON.parse(raw).captionProvenance.kind, "manual");
  assert.doesNotMatch(raw, /sig=|secret|https:/);
  const second = await runMediaJob(options);
  assert.equal(second.complete, true);
  assert.equal(fetched, 1);
  await writeFile(first.artifacts.formattedTranscript.path, "student annotation");
  const third = await runMediaJob(options);
  assert.equal(third.complete, false);
  assert.equal(
    await readFile(first.artifacts.formattedTranscript.path, "utf8"),
    "student annotation",
  );
  assert.equal(await readFile(first.artifacts.rawTranscript.path, "utf8"), raw);
  assert.equal(await readFile(first.artifacts.providerTranscript.path, "utf8"), original);
});

test("caption failure falls back to ASR with a redacted limitation and supplied speech evidence", async () => {
  const options = await jobFixture(async () => {
    throw new Error("failed https://fixture.invalid/caption?sig=secret");
  });
  const resolve = options.provider.resolve;
  options.provider.resolve = async (...args) => ({
    ...(await resolve(...args)),
    speechDuration: 5,
  });
  let transcribed = 0;
  options.transcriber = {
    version: "fixture",
    transcribe: async () => {
      transcribed++;
      return {
        sourceKind: "generated",
        language: "und",
        segments: [{ start: 0, end: 3, text: "Synthetic fallback words." }],
      };
    },
    release: async () => {},
  };
  const result = await runMediaJob(options);
  assert.equal(result.complete, true);
  assert.equal(result.speechDuration, 5);
  assert.equal(transcribed, 1);
  assert.match(
    result.limitations.join(" "),
    /Provider transcript retrieval failed: Caption fetch failed/,
  );
  assert.doesNotMatch(result.limitations.join(" "), /sig=|secret|https:/);
});

test("interrupted caption formatting resumes from retained source without refetching", async () => {
  let fetched = 0;
  const options = await jobFixture(async () => {
    fetched++;
    return new globalThis.Response(BODY);
  });
  const controller = new globalThis.AbortController();
  const error = new Error("fixture checkpoint");
  error.code = "MEDIA_CHECKPOINT";
  const interrupted = await runMediaJob({
    ...options,
    signal: controller.signal,
    formatter: {
      version: "fixture",
      format: async () => {
        controller.abort(error);
        throw error;
      },
    },
  });
  assert.equal(interrupted.stage, "checkpointed");
  const raw = await readFile(interrupted.artifacts.rawTranscript.path, "utf8");
  const resumed = await runMediaJob(options);
  assert.equal(resumed.complete, true);
  assert.equal(fetched, 1);
  assert.equal(await readFile(resumed.artifacts.rawTranscript.path, "utf8"), raw);
});
