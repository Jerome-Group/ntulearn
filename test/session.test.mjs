import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { openLoginWindow, openSignedInContext } from "../src/ntulearn/session.mjs";

for (const [name, openContext] of [
  ["login", openLoginWindow],
  ["signed-in", openSignedInContext],
]) {
  test(`${name} rejects a URL-encoded profile path before creating a second profile`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-session-"));
    const profile = join(root, "profile with spaces");
    const encodedPath = pathToFileURL(profile).pathname;

    assert.match(encodedPath, /%20/);
    await assert.rejects(openContext(encodedPath), /URL-encoded/);
    await assert.rejects(stat(profile), { code: "ENOENT" });
  });
}

test("caller-owned signed-in signals reach launch while ordinary and login semantics remain browser-owned", async (t) => {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-session-signal-"));
  try {
    const launches = [];
    let capture;
    const page = {
      on: (_event, callback) => {
        capture = callback;
      },
      goto: async () =>
        capture?.({ headers: () => ({ "x-blackboard-xsrf": "owned-fixture-token" }) }),
      waitForURL: async () => {},
      url: () => "fixture",
      reload: async () => {},
    };
    const launch = async (_profile, options) => {
      launches.push(options);
      return { pages: () => [page], close: async () => {} };
    };
    t.mock.method(chromium, "launchPersistentContext", launch);
    const caller = await openSignedInContext(join(root, "caller"), { signalOwner: "caller" });
    await caller.context.close();
    assert.equal(launches[0].handleSIGINT, false);
    assert.equal(launches[0].handleSIGTERM, false);
    assert.equal(launches[0].handleSIGHUP, undefined);
    const normal = await openSignedInContext(join(root, "normal"), {});
    await normal.context.close();
    assert.equal(launches[1].handleSIGINT, undefined);
    assert.equal(launches[1].handleSIGTERM, undefined);
    await (await openLoginWindow(join(root, "login"), {})).close();
    assert.equal(launches[2].handleSIGINT, undefined);
    assert.equal(launches[2].headless, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup operation failure distinguishes confirmed close from owned cleanup uncertainty", async (t) => {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-session-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationError = new Error("Owned fixture sign-in failure");
  for (const cleanupFails of [false, true]) {
    const closeError = new Error("Owned fixture close failure");
    let closes = 0;
    t.mock.method(chromium, "launchPersistentContext", async () => ({
      pages: () => [
        {
          on: () => {},
          goto: async () => {
            throw operationError;
          },
        },
      ],
      close: async () => {
        closes++;
        if (cleanupFails) throw closeError;
      },
    }));
    await assert.rejects(
      openSignedInContext(join(root, String(cleanupFails)), { signalOwner: "caller" }),
      (error) =>
        cleanupFails
          ? error.code === "NTULEARN_BROWSER_CLEANUP" && error.cause === closeError
          : error === operationError,
    );
    assert.equal(closes, 1);
    t.mock.restoreAll();
  }
});
