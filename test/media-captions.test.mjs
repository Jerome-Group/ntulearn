import assert from "node:assert/strict";
import test from "node:test";
import { createCaptionFetcher, youtubeCaptions } from "../src/media/captions.mjs";

test("caption fetch enforces declared and streamed byte limits without retaining signed failures", async () => {
  const address = "https://fixture.invalid/caption?sig=secret";
  for (const response of [
    new globalThis.Response("large", { headers: { "content-length": "5" } }),
    new globalThis.Response("large"),
  ]) {
    const fetch = createCaptionFetcher({ fetch: async () => response, maxBytes: 4 });
    await assert.rejects(fetch(address), /byte limit/);
  }
  const failed = createCaptionFetcher({
    fetch: async () => {
      throw new Error(`Caption fetch failed ${address}`);
    },
  });
  await assert.rejects(failed(address), (error) => !/sig|secret|https/.test(error.message));
  await assert.rejects(
    createCaptionFetcher({
      fetch: async () => new globalThis.Response("unavailable", { status: 403 }),
    })(address),
    /Retry provider resolution/,
  );
});

test("caption fetch times out and cancels even when transport ignores its signal", async () => {
  const address = "https://fixture.invalid/caption?sig=secret";
  const fetch = createCaptionFetcher({ fetch: async () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(fetch(address), /timed out/);
  const controller = new globalThis.AbortController();
  const pending = fetch(address, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /interrupted/);
  await assert.rejects(fetch(address, { signal: controller.signal }), /interrupted/);
});

test("caption choice is stable across metadata insertion order and unsafe addresses are ignored", () => {
  const en = [{ ext: "vtt", url: "https://fixture.invalid/en" }];
  const zh = [{ ext: "vtt", url: "https://fixture.invalid/zh" }];
  assert.deepEqual(
    youtubeCaptions({ subtitles: { zh, en } }),
    youtubeCaptions({ subtitles: { en, zh } }),
  );
  assert.deepEqual(
    youtubeCaptions({
      subtitles: {
        en: [
          { ext: "vtt", url: "file:///tmp/secret" },
          { ext: "vtt", url: "https://user:password@fixture.invalid/en" },
        ],
      },
    }),
    [],
  );
});
