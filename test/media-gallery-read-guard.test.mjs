import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { courseAnnouncementFixture, ANNOUNCEMENT_COURSE } from "./fixtures/course-announcement.mjs";
import { readKalturaMediaGallery } from "../src/media/gallery-browser.mjs";
import { runMediaDiscovery } from "../src/media/discover-run.mjs";
let originalLaunch;
test.before(() => {
  originalLaunch = chromium.launchPersistentContext;
  chromium.launchPersistentContext = () => {
    throw new Error("Offline browser guard");
  };
});
test.after(() => {
  chromium.launchPersistentContext = originalLaunch;
});
for (const [name, options] of [
  ["absent", { shown: false }],
  ["unknown", { unknown: true }],
  ["recognized", {}],
]) {
  test(`initial navigation NTULearn POST is guarded with ${name} dialog, before later reads`, async () => {
    const f = courseAnnouncementFixture(options);
    let forwarded = 0,
      reads = 0;
    const locator = f.page.locator;
    f.page.locator = (...args) => {
      reads++;
      return locator(...args);
    };
    f.page.goto = async () => {
      if (f.state.handler)
        await f.send("POST", "https://ntulearn.ntu.edu.sg/read?token=fixture-private");
      else forwarded++;
    };
    const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(forwarded, 0);
    assert.equal(f.state.routes, 1);
    assert.equal(f.state.abort, 1);
    assert.equal(result.complete, false);
    assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
    assert.equal(reads, 0);
    assert.equal(f.state.close, 0);
    assert.equal(f.state.gallery, 0);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|token=|POST/);
  });
}
test("guard registration is awaited before first goto; reads retain fallback", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  const events = [];
  let release, entered;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    pending = new Promise((resolve) => {
      release = resolve;
    });
  const route = f.context.route;
  f.context.route = async (...args) => {
    events.push("register");
    entered();
    await pending;
    await route(...args);
    events.push("registered");
  };
  f.page.goto = async () => {
    events.push("goto");
    await f.send("GET");
    await f.send("HEAD");
  };
  const running = readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  await started;
  assert.deepEqual(events, ["register"]);
  release();
  assert.equal((await running).complete, true);
  assert.deepEqual(events, ["register", "registered", "goto"]);
  assert.equal(f.state.fallback, 2);
  assert.equal(f.state.close, 0);
});

for (const [name, mutate, code] of [
  [
    "registration failure",
    (f) => {
      f.context.route = async () => {
        throw new Error("private registration");
      };
    },
    "GALLERY_NOTICE_READ_GUARD_FAILED",
  ],
  [
    "missing route",
    (f) => {
      delete f.context.route;
    },
    "GALLERY_NOTICE_READ_GUARD_FAILED",
  ],
  [
    "missing service-worker evidence",
    (f) => {
      delete f.context.serviceWorkers;
    },
    "GALLERY_NOTICE_READ_GUARD_FAILED",
  ],
  [
    "known service worker",
    (f) => {
      f.context.serviceWorkers = () => [{}];
    },
    "GALLERY_NOTICE_SERVICE_WORKER",
  ],
])
  test(`${name} refuses initial navigation even without a dialog`, async () => {
    const f = courseAnnouncementFixture({ shown: false });
    let navigations = 0;
    f.page.goto = async () => {
      navigations++;
    };
    mutate(f);
    const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostic.code, code);
    assert.equal(navigations, 0);
    assert.equal(f.state.gallery, 0);
    assert.equal(f.state.close, 0);
  });
test("blocked initial request stays sticky and prevents reuse navigation", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  let navigations = 0;
  f.page.goto = async () => {
    navigations++;
    await f.send("POST");
  };
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).diagnostic.code,
    "GALLERY_NOTICE_WRITE_BLOCKED",
  );
  f.page.goto = async () => {
    navigations++;
  };
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).diagnostic.code,
    "GALLERY_NOTICE_WRITE_BLOCKED",
  );
  assert.equal(navigations, 1);
  assert.equal(f.state.routes, 1);
});
test("initial blocked course remains incomplete while positively closed next owned context succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-guard-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const courses = ["A", "B"].map((key) => ({
    ...ANNOUNCEMENT_COURSE,
    key,
    courseId: `_${key}_1`,
    mediaMode: "active",
    destination: join(root, key),
  }));
  const events = [],
    fixtures = [];
  const config = {
    courses,
    statePath: join(root, "state.json"),
    profilePath: join(root, "profile"),
  };
  const result = await runMediaDiscovery(
    { config, key: "all" },
    {
      admission: async () => {},
      open: async () => {
        const index = fixtures.length,
          f = courseAnnouncementFixture({ shown: false });
        fixtures.push(f);
        events.push(`open${index}`);
        f.page.goto = async () => {
          events.push(`goto${index}`);
          await f.send(index === 0 ? "POST" : "GET");
        };
        return {
          readCourse: async () => ({ items: [] }),
          withBrowserPage: async (read) => read(f.page),
          close: async () => {
            events.push(`close${index}`);
          },
        };
      },
      writeQueue: async ({ course }) => {
        events.push(`write${course.key}`);
        return { path: "owned synthetic queue" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.courses.map((c) => c.complete),
    [false, true],
  );
  assert.deepEqual(events, [
    "open0",
    "goto0",
    "close0",
    "writeA",
    "open1",
    "goto1",
    "close1",
    "writeB",
  ]);
  assert.equal(fixtures[0].state.abort, 1);
  assert.equal(fixtures[1].state.abort, 0);
  assert.equal(fixtures[1].state.fallback, 1);
  assert.equal(result.notAttempted.length, 0);
  assert.equal(result.cleanup, "confirmed");
});
test("guard failure during catalogue read refuses before any later pagination", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  let reads = 0;
  const frame = f.page.frames()[0],
    original = frame.evaluate;
  frame.evaluate = async () => {
    reads++;
    await f.send("PUT");
    return original();
  };
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(f.state.abort, 1);
  assert.equal(reads, 1);
});

test("initial navigation rejection cannot mask retained blocked-request evidence", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  f.page.goto = async () => {
    await f.send("POST");
    throw new Error("private navigation aborted");
  };
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(f.state.gallery, 0);
  assert.doesNotMatch(JSON.stringify(result), /private navigation/);
});

test("trigger error cannot mask concurrently blocked non-read evidence", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  let clicks = 0;
  const original = f.page.getByRole;
  f.page.getByRole = (...args) => {
    const control = original(...args);
    return {
      ...control,
      first() {
        return this;
      },
      click: async () => {
        clicks++;
        await f.send("POST");
        throw new Error("private trigger transport failure");
      },
    };
  };
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(clicks, 1);
  assert.equal(f.state.abort, 1);
  assert.equal(result.diagnostic.stage, "opening");
  assert.doesNotMatch(JSON.stringify(result), /private trigger transport/);
});
test("detail navigation error cannot mask concurrently blocked non-read evidence", async () => {
  const f = courseAnnouncementFixture({ shown: false }),
    frame = f.page.frames()[0];
  let closed = 0,
    navigations = 0;
  const original = frame.evaluate;
  frame.url = () => "https://provider.example/channel";
  frame.evaluate = async () => {
    const result = await original();
    delete result.entries[0].createdAt;
    result.entries[0].href = "https://provider.example/media/fixture";
    return result;
  };
  f.context.newPage = async () => ({
    goto: async () => {
      navigations++;
      await f.send("POST");
      throw new Error("private detail navigation failure");
    },
    close: async () => {
      closed++;
    },
  });
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(result.diagnostic.stage, "date-enrichment");
  assert.equal(navigations, 1);
  assert.equal(closed, 1);
  assert.equal(f.state.abort, 1);
  assert.doesNotMatch(JSON.stringify(result), /private detail navigation|provider\.example/);
});
