import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import {
  captureKalturaResponses,
  KALTURA_RESPONSE_LIMITS,
} from "../src/media/kaltura-responses.mjs";

const limits = {
  ...KALTURA_RESPONSE_LIMITS,
  manifestBytes: 128,
  captionBytes: 128,
  retainedBytes: 256,
  drainMs: 20,
};
const response = (kind, body, extra = {}) => ({
  url: () => `https://synthetic.invalid/${kind === "manifest" ? "playManifest" : "caption.vtt"}`,
  text: async () => body,
  ...extra,
});
const vtt = "WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n<v Speaker>Exact &amp; original\r\n";

test("capture preserves admitted caption bytes and never retains addresses", async () => {
  const capture = captureKalturaResponses({ limits });
  capture.observe(response("caption", vtt));
  const result = await capture.finish();
  assert.deepEqual(result.captions, [vtt]);
  assert.equal(result.retainedBytes, Buffer.byteLength(vtt));
  assert.equal(JSON.stringify(result).includes("synthetic.invalid"), false);
});

test("announced size refuses text reads; received size never truncates captions", async () => {
  for (const extra of [
    { headers: () => ({ "content-length": "129" }) },
    { allHeaders: async () => ({ "content-length": "8589934592" }) },
  ]) {
    let reads = 0;
    const capture = captureKalturaResponses({ limits });
    capture.observe(
      response("caption", vtt, {
        ...extra,
        text: async () => {
          reads++;
          return vtt;
        },
      }),
    );
    const result = await capture.finish();
    assert.equal(reads, 0);
    assert.equal(result.captions.length, 0);
    assert.equal(result.limitations.length, 1);
  }
  const capture = captureKalturaResponses({ limits });
  capture.observe(response("caption", "WEBVTT" + "x".repeat(128)));
  assert.equal((await capture.finish()).captions.length, 0);
});

test("manifest overflow and listener exceptions are observed and sanitized", async () => {
  for (const value of [
    response("manifest", "x".repeat(129)),
    {
      url: () => {
        throw new Error("synthetic-private-address");
      },
    },
  ]) {
    const capture = captureKalturaResponses({ limits });
    assert.equal(capture.observe(value), undefined);
    await assert.rejects(capture.finish(), (error) => {
      assert.match(error.message, /Retry signed-in playback/);
      assert.equal(error.message.includes("synthetic-private"), false);
      return true;
    });
  }
});

test("eligible count and in-flight limits bound body work", async () => {
  let reads = 0;
  const capture = captureKalturaResponses({ limits: { ...limits, responses: 2, inFlight: 1 } });
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  capture.observe(
    response("caption", vtt, {
      text: () => {
        reads++;
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
  );
  capture.observe(
    response("caption", vtt, {
      text: async () => {
        reads++;
        return vtt;
      },
    }),
  );
  await ready;
  release(vtt);
  await Promise.resolve();
  await Promise.resolve();
  capture.observe(response("caption", vtt));
  const result = await capture.finish();
  assert.equal(reads, 1);
  assert.equal(result.captions.length, 1);
  assert.equal(result.limitations.length, 1);
});

test("aggregate bound checks actual UTF-8 bytes before retaining", async () => {
  const capture = captureKalturaResponses({ limits: { ...limits, retainedBytes: 80 } });
  capture.observe(response("caption", "WEBVTT" + "é".repeat(30)));
  capture.observe(response("caption", "WEBVTT" + "é".repeat(30)));
  const result = await capture.finish();
  assert.equal(result.captions.length, 1);
  assert.equal(result.retainedBytes, 66);
  assert.equal(result.limitations.length, 1);
});

test("pending read drains logically and late completion cannot mutate the result", async () => {
  let release;
  const capture = captureKalturaResponses({ limits });
  capture.observe(
    response("caption", vtt, {
      text: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  );
  const result = await capture.finish();
  assert.equal(result.captions.length, 0);
  assert.equal(result.limitations.length, 1);
  release(vtt);
  await Promise.resolve();
  assert.equal(result.captions.length, 0);
  capture.observe(response("manifest", "late"));
  assert.equal(capture.manifests.length, 0);
});

test("abort and observed global safety retain their original reasons; fresh capture recovers", async () => {
  const controller = new globalThis.AbortController();
  const capture = captureKalturaResponses({ signal: controller.signal, limits });
  capture.observe(response("caption", vtt, { text: () => new Promise(() => {}) }));
  const reason = Object.assign(new Error("Synthetic global safety"), { globalSafety: true });
  controller.abort(reason);
  await assert.rejects(capture.finish(), (error) => error === reason);
  const global = captureKalturaResponses({ limits });
  global.observe(
    response("caption", vtt, {
      text: async () => {
        throw reason;
      },
    }),
  );
  await assert.rejects(global.finish(), (error) => error === reason);
  const fresh = captureKalturaResponses({ limits });
  fresh.observe(response("caption", vtt));
  assert.deepEqual((await fresh.finish()).captions, [vtt]);
});

test("settled responses still consume the eligible response count budget", async () => {
  let reads = 0;
  const capture = captureKalturaResponses({ limits: { ...limits, responses: 2 } });
  for (let index = 0; index < 3; index++) {
    capture.observe(
      response("caption", vtt, {
        text: async () => {
          reads++;
          return vtt;
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await capture.finish();
  assert.equal(reads, 2);
  assert.equal(result.captions.length, 2);
  assert.equal(result.limitations.length, 1);
});

test("code-only and nested-cause global failures never degrade to caption fallback", async () => {
  for (const code of ["ENOSPC", "EACCES"]) {
    const cause = Object.assign(new Error("Synthetic storage refusal"), { code });
    for (const error of [cause, new Error("Synthetic wrapped refusal", { cause })]) {
      const capture = captureKalturaResponses({ limits });
      capture.observe(
        response("caption", vtt, {
          text: async () => {
            throw error;
          },
        }),
      );
      await assert.rejects(capture.finish(), (actual) => actual === error);
    }
  }
});

test("observed storage safety takes priority over a simultaneous ordinary checkpoint", async () => {
  const controller = new globalThis.AbortController();
  const error = Object.assign(new Error("Synthetic storage full"), { code: "ENOSPC" });
  const capture = captureKalturaResponses({ limits, signal: controller.signal });
  capture.observe(
    response("caption", vtt, {
      text: async () => {
        throw error;
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("Synthetic checkpoint"));
  await assert.rejects(capture.finish(), (actual) => actual === error);
});

test("later aborted pending response cannot replace an observed global failure", async () => {
  const controller = new globalThis.AbortController();
  const safety = Object.assign(new Error("Synthetic storage full"), { code: "ENOSPC" });
  let rejectPending;
  const capture = captureKalturaResponses({ limits, signal: controller.signal });
  capture.observe(
    response("caption", vtt, {
      text: async () => {
        throw safety;
      },
    }),
  );
  capture.observe(
    response("caption", vtt, {
      text: () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("Synthetic ordinary checkpoint"));
  rejectPending(new Error("Synthetic body interruption"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(capture.finish(), (error) => error === safety);
});
