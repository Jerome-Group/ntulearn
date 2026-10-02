import assert from "node:assert/strict";
import test from "node:test";
import { readCollection } from "../src/ntulearn/collections.mjs";

test("follows every collection page in order", async () => {
  const calls = [];
  const result = await readCollection(async (path) => {
    calls.push(path);
    return path === "/first"
      ? { results: ["a"], paging: { nextPage: "/next" } }
      : { results: ["b"] };
  }, "/first");
  assert.deepEqual(result.results, ["a", "b"]);
  assert.deepEqual(calls, ["/first", "/next"]);
});

test("refuses repeated next-page addresses instead of looping or truncating", async () => {
  let requests = 0;
  await assert.rejects(
    readCollection(async () => {
      requests += 1;
      return { results: [], paging: { nextPage: "https://ntulearn.ntu.edu.sg/first" } };
    }, "/first"),
    /pagination.*Run/i,
  );
  assert.equal(requests, 1);
});

test("an optional later refusal discards incomplete rows and remains unavailable", async () => {
  const result = await readCollection(
    async (path, options) => {
      assert.equal(options.optional, true);
      return path === "/first"
        ? { results: ["a"], paging: { nextPage: "/next" } }
        : { results: [], unavailable: true };
    },
    "/first",
    { optional: true },
  );
  assert.deepEqual(result, { results: [], unavailable: true });
});

test("propagates session and required-read errors without hiding partial failure", async () => {
  const failure = new Error("Run: npm run login");
  await assert.rejects(
    readCollection(async () => {
      throw failure;
    }, "/first"),
    (error) => error === failure,
  );
});

test("bounds distinct endless pages, rejecting malformed or foreign pagination", async () => {
  let requests = 0;
  await assert.rejects(
    readCollection(
      async () => ({ results: [], paging: { nextPage: `/page-${++requests}` } }),
      "/first",
    ),
    /pagination/,
  );
  assert.equal(requests, 1_000);
  for (const nextPage of [0, false, {}, " ", "https://foreign.example/next"]) {
    await assert.rejects(
      readCollection(async () => ({ results: [], paging: { nextPage } }), "/first"),
      /pagination/,
    );
  }
  await assert.rejects(
    readCollection(async () => null, "/first"),
    /pagination/,
  );
});

test("refuses successful collection pages missing their result array", async () => {
  for (const page of [{}, { results: null }, { results: "rows" }]) {
    await assert.rejects(
      readCollection(async () => page, "/first"),
      /pagination/,
    );
  }
});

test("required collections cannot claim optional unavailability", async () => {
  await assert.rejects(
    readCollection(async () => ({ unavailable: true }), "/required"),
    /pagination/,
  );
});
