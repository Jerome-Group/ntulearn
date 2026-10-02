import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { safeNativeTranscriptBody } from "../src/media/native-transcript-safety.mjs";

test("inspects supported native escaping without publishing session addresses", () => {
  for (const body of [
    '{"text":"https:\\/\\/video.test/caption?\\u0073ig=synthetic-private-credential"}',
    '{"https:\\/\\/video.test/caption?\\u0073ig=synthetic-private-credential":"metadata"}',
    "WEBVTT\n\n00:00.000 --> 00:10.000\nCaption https://video.test/caption?&#115;ig=synthetic-private-credential",
    "1\n00:00:00,000 --> 00:00:10,000\nCaption https://video.test/caption?chapter=1&amp;%73ig=synthetic-private-credential",
    "<tt><p>https://video.test/api/&#107;s/synthetic-private-credential/captions</p></tt>",
    "https://video.test/api/%6Bs%2Fsynthetic-private-credential/captions",
    "/api/ks/synthetic-private-credential/captions",
    "?%73ig=synthetic-private-credential",
    "https://video.test/caption?bad%=x&%73ig=synthetic-private-credential",
  ]) {
    for (const native of [body, Buffer.from(body)]) {
      assert.throws(
        () => safeNativeTranscriptBody(native),
        (error) =>
          /session-bound address.*Retry/.test(error.message) &&
          !error.message.includes("synthetic-private-credential"),
      );
    }
  }
});

test("safe native bytes, stable links, chapters and percent notation are unchanged", () => {
  const text =
    "50% and x % 2; https://docs.test/chapter/2?part=3&ratio=50%25 https://docs.test/session/overview";
  for (const body of [
    JSON.stringify({ language: "en", segments: [{ start: 0, end: 10, text }] }),
    `WEBVTT\n\n00:00.000 --> 00:10.000\n${text}`,
    `1\n00:00:00,000 --> 00:00:10,000\n${text}`,
    `<tt><p>${text.replaceAll("&", "&amp;")}</p></tt>`,
  ]) {
    assert.equal(safeNativeTranscriptBody(body), body);
    const buffer = Buffer.from(body);
    assert.equal(safeNativeTranscriptBody(buffer), buffer);
  }
  const object = { segments: [{ text }] };
  assert.deepEqual(
    safeNativeTranscriptBody({ content: object }),
    Buffer.from(JSON.stringify(object)),
  );
});

test("inspection bounds bytes, native object depth/value count, UTF-8 and URL parsing", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let deep = "caption";
  for (let i = 0; i < 18; i++) deep = { nested: deep };
  for (const body of [
    "x".repeat(4 * 1024 * 1024 + 1),
    { text: "x".repeat(4 * 1024 * 1024 + 1) },
    cyclic,
    deep,
    Array(100001).fill("caption"),
    Buffer.from([0xff]),
    "https://invalid%host.test/caption",
    "https://video.test/" + "x".repeat(4096),
    Array(4097).fill("https://video.test/caption").join(" "),
  ])
    assert.throws(() => safeNativeTranscriptBody(body), /inspection.*limits.*Inspect/);
});

test("native object admission does not execute accessors or custom serialization", () => {
  let invoked = false;
  for (const body of [
    {
      get body() {
        invoked = true;
        return "caption";
      },
    },
    {
      get text() {
        invoked = true;
        return "caption";
      },
    },
    {
      toJSON() {
        invoked = true;
        return { text: "caption" };
      },
    },
  ])
    assert.throws(() => safeNativeTranscriptBody(body), /inspection.*Inspect/);
  assert.equal(invoked, false);
});

test("nonenumerable and inherited serialization hooks cannot escape native admission", () => {
  let calls = 0;
  for (const body of [{ text: "caption" }, ["caption"]]) {
    for (const descriptor of [
      {
        value() {
          calls++;
          return { text: "uninspected replacement" };
        },
      },
      {
        get() {
          calls++;
          return () => ({ text: "uninspected replacement" });
        },
      },
    ]) {
      const native = Array.isArray(body) ? [...body] : { ...body };
      Object.defineProperty(native, "toJSON", descriptor);
      assert.throws(() => safeNativeTranscriptBody(native), /inspection.*Inspect/);
    }
  }
  for (const prototype of [Object.prototype, Array.prototype]) {
    const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
    try {
      for (const descriptor of [
        {
          value() {
            calls++;
            return { text: "uninspected replacement" };
          },
        },
        {
          get() {
            calls++;
            return () => ({ text: "uninspected replacement" });
          },
        },
      ]) {
        Object.defineProperty(prototype, "toJSON", { ...descriptor, configurable: true });
        assert.throws(
          () =>
            safeNativeTranscriptBody(
              prototype === Array.prototype ? ["caption"] : { text: "caption" },
            ),
          /inspection.*Inspect/,
        );
      }
    } finally {
      if (previous) Object.defineProperty(prototype, "toJSON", previous);
      else delete prototype.toJSON;
    }
  }
  assert.equal(calls, 0);
  const safe = { text: "caption", toJSON: "ordinary native JSON field" };
  assert.deepEqual(safeNativeTranscriptBody(safe), Buffer.from(JSON.stringify(safe)));
});

test("array admission inspects nonenumerable and inherited serialized indices without calling getters", () => {
  let calls = 0;
  const native = [];
  Object.defineProperty(native, "0", {
    get() {
      calls++;
      return "uninspected caption";
    },
  });
  assert.throws(() => safeNativeTranscriptBody(native), /inspection.*Inspect/);
  for (const prototype of [Array.prototype, Object.prototype]) {
    const previous = Object.getOwnPropertyDescriptor(prototype, "0");
    try {
      Object.defineProperty(prototype, "0", {
        get() {
          calls++;
          return "uninspected caption";
        },
        configurable: true,
      });
      assert.throws(() => safeNativeTranscriptBody(Array(1)), /inspection.*Inspect/);
    } finally {
      if (previous) Object.defineProperty(prototype, "0", previous);
      else delete prototype[0];
    }
  }
  assert.equal(calls, 0);
  const nonenumerable = [];
  Object.defineProperty(nonenumerable, "0", { value: "safe caption" });
  for (const body of [["safe", 2, null], Array(3), nonenumerable])
    assert.deepEqual(safeNativeTranscriptBody(body), Buffer.from(JSON.stringify(body)));
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
  try {
    Object.defineProperty(Array.prototype, "0", {
      value: "safe inherited caption",
      writable: true,
      configurable: true,
    });
    const sparse = Array(1);
    assert.deepEqual(safeNativeTranscriptBody(sparse), Buffer.from(JSON.stringify(sparse)));
    Object.defineProperty(Array.prototype, "0", {
      value: "https://video.test/caption?%73ig=synthetic-private-credential",
      writable: true,
      configurable: true,
    });
    assert.throws(() => safeNativeTranscriptBody(sparse), /session-bound address/);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, "0", previous);
    else delete Array.prototype[0];
  }
});
