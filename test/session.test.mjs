import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
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

test("signed-in and login launches retain browser signal ownership", async (t) => {
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
    const normal = await openSignedInContext(join(root, "normal"));
    await normal.context.close();
    assert.equal(launches[0].handleSIGINT, undefined);
    assert.equal(launches[0].handleSIGTERM, undefined);
    await (await openLoginWindow(join(root, "login"))).close();
    assert.equal(launches[1].handleSIGINT, undefined);
    assert.equal(launches[1].headless, false);
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
    await assert.rejects(openSignedInContext(join(root, String(cleanupFails))), (error) =>
      cleanupFails
        ? error.code === "NTULEARN_BROWSER_CLEANUP" && error.cause === closeError
        : error === operationError,
    );
    assert.equal(closes, 1);
    t.mock.restoreAll();
  }
});

for (const phase of ["newPage", "goto"]) {
  for (const cleanupFails of [false, true]) {
    test(`login ${phase} failure ${cleanupFails ? "reports cleanup uncertainty" : "closes before rejecting"}`, async (t) => {
      const { rm } = await import("node:fs/promises");
      const root = await mkdtemp(join(tmpdir(), "ntulearn-login-startup-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const operationError = new Error("Owned fixture login startup failure");
      const closeError = new Error("Owned fixture close failure");
      let closes = 0;
      let cleanupSettled = false;
      const page = {
        goto: async () => {
          if (phase === "goto") throw operationError;
        },
      };
      t.mock.method(chromium, "launchPersistentContext", async () => ({
        pages: () => [],
        newPage: async () => {
          if (phase === "newPage") throw operationError;
          return page;
        },
        close: async () => {
          closes++;
          await setImmediate();
          cleanupSettled = true;
          if (cleanupFails) throw closeError;
        },
      }));

      await assert.rejects(openLoginWindow(root), (error) => {
        assert.equal(closes, 1);
        assert.equal(cleanupSettled, true);
        if (cleanupFails) {
          assert.equal(error.code, "NTULEARN_BROWSER_CLEANUP");
          assert.equal(error.cause, closeError);
          assert.match(error.message, /Inspect .* before retrying/);
        } else {
          assert.equal(error, operationError);
        }
        return true;
      });
    });
  }
}

for (const existingPage of [false, true]) {
  test(`successful login with ${existingPage ? "an existing" : "a new"} page leaves closing to the caller`, async (t) => {
    const { rm } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "ntulearn-login-success-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let closes = 0;
    let navigated = false;
    const page = {
      goto: async () => {
        navigated = true;
      },
    };
    t.mock.method(chromium, "launchPersistentContext", async () => ({
      pages: () => (existingPage ? [page] : []),
      newPage: async () => page,
      close: async () => {
        closes++;
      },
    }));

    const window = await openLoginWindow(root);
    assert.equal(window.page, page);
    assert.equal(navigated, true);
    assert.equal(closes, 0);
    await window.close();
    assert.equal(closes, 1);
  });
}
