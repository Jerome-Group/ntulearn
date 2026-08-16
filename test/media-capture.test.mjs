import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createPlaybackCapture, resolvePlaybackRate } from "../src/media/capture.mjs";

const APPEARANCE = {
  recordingId: "content-tree:item-1:opaque-player",
  provider: "unsupported",
  sourceKind: "embedded-player",
  providerReference: "unsupported:player.example.test/lecture",
};

test("starts directly without a scheduler and probes playback at the default 1x rate", async () => {
  const events = [];
  const capture = createPlaybackCapture({
    playback: fakePlayback(events, {
      probe: { audible: true, intelligible: true },
      media: {
        kind: "video",
        body: Buffer.from("captured video"),
        filename: "lecture.mp4",
        url: "https://video.example.test/lecture.mp4?fixture=1",
      },
    }),
    audioRouting: fakeAudioRouting(events),
  });

  const result = await capture.media({ appearance: APPEARANCE, resolved: null });

  assert.deepEqual(result, {
    kind: "video",
    body: Buffer.from("captured video"),
    filename: "lecture.mp4",
    audio: true,
    limitation: "Media retained from signed-in browser playback capture.",
  });
  assert.deepEqual(events, [
    ["route:prepare"],
    ["playback:open", 1],
    ["playback:probe", 3_000, 1],
    ["playback:capture", 1],
    ["playback:stop"],
    ["route:restore"],
  ]);
});

test("aborts silent or unintelligible probes without committing a capture", async () => {
  for (const probe of [
    { audible: false, intelligible: true },
    { audible: true, intelligible: false },
    { meaningful: false },
  ]) {
    const events = [];
    const capture = createPlaybackCapture({
      playback: fakePlayback(events, { probe, media: { kind: "audio", body: Buffer.from("no") } }),
      audioRouting: fakeAudioRouting(events),
    });

    const result = await capture.media({ appearance: APPEARANCE, resolved: null });

    assert.equal(result.kind, "unavailable");
    assert.equal(result.retryable, true);
    assert.match(result.limitation, /silent or unintelligible/i);
    assert.equal(
      events.some(([name]) => name === "playback:capture"),
      false,
    );
    assert.deepEqual(events.slice(-2), [["playback:stop"], ["route:restore"]]);
  }
});

test("restores playback and audio routing when capture fails", async () => {
  const events = [];
  const capture = createPlaybackCapture({
    playback: fakePlayback(events, {
      probe: { audible: true, intelligible: true },
      captureError: new Error("capture timed out"),
    }),
    audioRouting: fakeAudioRouting(events),
  });

  await assert.rejects(
    capture.media({ appearance: APPEARANCE, resolved: null }),
    /Browser playback capture failed: capture timed out/,
  );
  assert.deepEqual(events.slice(-2), [["playback:stop"], ["route:restore"]]);
});

test("restores playback and routing when an interruption forces a checkpoint", async () => {
  const events = [];
  const controller = new globalThis.AbortController();
  const playback = fakePlayback(events, {
    probe: { audible: true, intelligible: true },
    media: { kind: "audio", body: Buffer.from("never committed") },
  });
  playback.probe = async () => {
    events.push(["playback:probe", 3_000, 1]);
    controller.abort(new Error("forced checkpoint"));
    throw new Error("forced checkpoint");
  };
  const capture = createPlaybackCapture({
    playback,
    audioRouting: fakeAudioRouting(events),
  });

  await assert.rejects(
    capture.media({ appearance: APPEARANCE, signal: controller.signal }),
    /Browser playback capture failed: Browser playback capture interrupted/,
  );
  assert.deepEqual(events.slice(-2), [["playback:stop"], ["route:restore"]]);
});

test("keeps 2x disabled until provider-specific Owner evidence covers all checks", () => {
  assert.equal(resolvePlaybackRate({ provider: "kaltura", requestedRate: 2 }), 1);
  assert.equal(
    resolvePlaybackRate({
      provider: "kaltura",
      requestedRate: 2,
      ownerEvidence: {
        provider: "kaltura",
        recordedBy: "Owner",
        evidenceId: "owner-check-kaltura-1",
        recordedAt: "2026-08-16T00:00:00+08:00",
        durationCoverage: true,
        timestampAlignment: true,
        intelligibility: true,
      },
    }),
    2,
  );
  assert.equal(
    resolvePlaybackRate({
      provider: "youtube",
      requestedRate: 2,
      ownerEvidence: {
        provider: "kaltura",
        recordedBy: "Owner",
        durationCoverage: true,
        timestampAlignment: true,
        intelligibility: true,
      },
    }),
    1,
  );
});

test("times out a hanging probe and still restores routing", async () => {
  const events = [];
  const capture = createPlaybackCapture({
    timeoutMs: 20,
    playback: fakePlayback(events, {
      probePromise: new Promise(() => {}),
      media: { kind: "audio", body: Buffer.from("never committed") },
    }),
    audioRouting: fakeAudioRouting(events),
  });

  await assert.rejects(
    capture.media({ appearance: APPEARANCE, resolved: null }),
    /Browser playback capture failed: Browser playback capture timed out.*Retry/i,
  );
  assert.deepEqual(events.slice(-2), [["playback:stop"], ["route:restore"]]);
});

function fakePlayback(events, { probe, probePromise = null, media, captureError = null }) {
  return {
    async open({ rate, studentVisibleOnly }) {
      assert.equal(studentVisibleOnly, true);
      events.push(["playback:open", rate]);
      return { id: "session" };
    },
    async probe(_session, { durationMs, rate }) {
      events.push(["playback:probe", durationMs, rate]);
      if (probePromise) return probePromise;
      return probe;
    },
    async capture(_session, { rate, studentVisibleOnly }) {
      assert.equal(studentVisibleOnly, true);
      events.push(["playback:capture", rate]);
      if (captureError) throw captureError;
      return media;
    },
    async stop() {
      events.push(["playback:stop"]);
    },
  };
}

function fakeAudioRouting(events) {
  return {
    async prepare() {
      events.push(["route:prepare"]);
      return { id: "route" };
    },
    async restore() {
      events.push(["route:restore"]);
    },
  };
}
