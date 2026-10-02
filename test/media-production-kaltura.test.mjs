import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { createProductionKalturaProvider } from "../src/media/production-kaltura.mjs";

function fixture(onGoto, overrides = {}) {
  let listener;
  let removed = 0;
  const page = {
    on: (_name, callback) => {
      listener = callback;
    },
    off: () => {
      removed++;
    },
    goto: async () => onGoto(listener),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (selector) =>
      selector === "body"
        ? { innerText: async () => "0:00 / 0:20" }
        : { first: () => ({ count: async () => 0 }) },
    ...overrides,
  };
  return { provider: createProductionKalturaProvider(page, {}), removed: () => removed };
}
const manifest = {
  url: () => "https://synthetic.invalid/playManifest",
  text: async () => "https://synthetic.invalid/index.m3u8",
};
const appearance = { providerReference: "entry:synthetic" };

test("actual adapter refuses announced oversized captions before reading and keeps playable media", async () => {
  let reads = 0;
  const at = fixture(async (emit) => {
    emit(manifest);
    emit({
      url: () => "https://synthetic.invalid/caption.vtt",
      headers: () => ({ "content-length": "8589934592" }),
      text: async () => {
        reads++;
        return "WEBVTT";
      },
    });
  });
  const result = await at.provider.resolve(appearance);
  assert.equal(reads, 0);
  assert.equal(result.transcript, undefined);
  assert.equal(result.limitations.length, 1);
  assert.equal(result.duration, 20);
  assert.ok(result.media.video.length);
  assert.equal(JSON.stringify(result.limitations).includes("synthetic.invalid"), false);
});

test("actual adapter preserves provider caption text and observed provenance", async () => {
  const body = "WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n<v Speaker>Unchanged &amp; text\r\n";
  const at = fixture(async (emit) => {
    emit(manifest);
    emit({ url: () => "https://synthetic.invalid/caption.vtt", text: async () => body });
  });
  const result = await at.provider.resolve(appearance);
  assert.equal(result.transcript.body, body);
  assert.deepEqual(result.transcript.captionProvenance, {
    kind: "observed",
    language: "und",
    format: "vtt",
  });
});

test("actual adapter tracks listener failure and cleans listener registration", async () => {
  const at = fixture(async (emit) => {
    emit({
      url: () => {
        throw new Error("synthetic-private-address");
      },
    });
  });
  await assert.rejects(at.provider.resolve(appearance), /capture could not be verified/);
  assert.ok(at.removed() > 0);
});

test("actual adapter cancellation retains reason with pending navigation and body work", async () => {
  let releaseBody;
  let releaseGoto;
  const at = fixture((emit) => {
    emit({
      url: () => "https://synthetic.invalid/caption.vtt",
      text: () =>
        new Promise((resolve) => {
          releaseBody = resolve;
        }),
    });
    return new Promise((resolve) => {
      releaseGoto = resolve;
    });
  });
  const controller = new globalThis.AbortController();
  const reason = Object.assign(new Error("Synthetic cutoff"), { globalSafety: true });
  const pending = at.provider.resolve(appearance, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.ok(at.removed() > 0);
  releaseBody?.("WEBVTT");
  releaseGoto();
  const fresh = fixture(async (emit) => emit(manifest));
  assert.equal((await fresh.provider.resolve(appearance)).duration, 20);
});

test("actual adapter bounds a burst of 300 announced oversized responses without allocating bodies", async () => {
  let reads = 0;
  const at = fixture(async (emit) => {
    emit(manifest);
    for (let index = 0; index < 300; index++)
      emit({
        url: () => "https://synthetic.invalid/caption.vtt",
        headers: () => ({ "content-length": "8589934592" }),
        text: async () => {
          reads++;
          return "WEBVTT";
        },
      });
  });
  const result = await at.provider.resolve(appearance);
  assert.equal(reads, 0);
  assert.equal(result.transcript, undefined);
  assert.equal(result.limitations.length, 1);
});

test("actual adapter preserves code-only and cause-wrapped safety failures from optional browser waits", async () => {
  for (const code of ["ENOSPC", "EACCES"]) {
    const cause = Object.assign(new Error("Synthetic safety refusal"), { code });
    for (const error of [cause, new Error("Synthetic wrapped refusal", { cause })]) {
      const at = fixture(async (emit) => emit(manifest), {
        waitForLoadState: async () => {
          throw error;
        },
      });
      await assert.rejects(at.provider.resolve(appearance), (actual) => actual === error);
    }
  }
});

test("actual adapter retains observed safety when another pending read aborts", async () => {
  const controller = new globalThis.AbortController();
  const safety = Object.assign(new Error("Synthetic storage full"), { code: "ENOSPC" });
  let rejectPending;
  const at = fixture(async (emit) => {
    emit(manifest);
    emit({
      url: () => "https://synthetic.invalid/caption.vtt",
      text: async () => {
        throw safety;
      },
    });
    emit({
      url: () => "https://synthetic.invalid/subtitle.vtt",
      text: () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("Synthetic ordinary checkpoint"));
    rejectPending(new Error("Synthetic body interruption"));
    await new Promise((resolve) => setImmediate(resolve));
  });
  await assert.rejects(
    at.provider.resolve(appearance, { signal: controller.signal }),
    (error) => error === safety,
  );
});
