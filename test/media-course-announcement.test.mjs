import assert from "node:assert/strict";
import test from "node:test";
import { readKalturaMediaGallery } from "../src/media/gallery-browser.mjs";
import { courseAnnouncementFixture, ANNOUNCEMENT_COURSE } from "./fixtures/course-announcement.mjs";
test("known course announcement blocks Gallery until dedicated guarded Close, then ordinary authority succeeds", async () => {
  const f = courseAnnouncementFixture();
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, true);
  assert.equal(result.displayedCount, 1);
  assert.equal(result.discoveredCount, 1);
  assert.equal(f.state.close, 1);
  assert.equal(f.state.mark, 0);
  assert.equal(f.state.routes, 1);
  assert.equal(f.state.gallery, 1);
});

test("known Close never selects Mark as read; NTULearn write attempt aborts and leaves discovery red/private-safe", async () => {
  const f = courseAnnouncementFixture({
    duringClose: ({ send }) =>
      send("POST", "https://ntulearn.ntu.edu.sg/private?token=fixture-private"),
  });
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(f.state.abort, 1);
  assert.equal(f.state.fallback, 0);
  assert.equal(f.state.gallery, 0);
  assert.equal(f.state.mark, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|private\?|POST|headers|payload/);
});
test("GET/HEAD preserve lower route handlers; guard remains context-owned and reused across discoveries", async () => {
  const f = courseAnnouncementFixture({
    duringClose: async ({ send }) => {
      await send("GET");
      await send("HEAD");
    },
  });
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).complete,
    true,
  );
  f.state.shown = true;
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).complete,
    true,
  );
  assert.equal(f.state.routes, 1);
  assert.equal(f.state.close, 2);
  assert.equal(f.state.fallback, 4);
  await f.send("PUT");
  const refused = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(refused.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(f.state.routes, 1);
  assert.equal(f.state.close, 2);
});
for (const [name, options, code] of [
  ["unknown dialog", { unknown: true }, "GALLERY_NOTICE_UNRECOGNIZED"],
  ["multiple dialogs", { modals: 2 }, "GALLERY_NOTICE_UNRECOGNIZED"],
  ["multiple headings", { headingCount: 2 }, "GALLERY_NOTICE_UNRECOGNIZED"],
  ["missing Close", { closeCount: 0 }, "GALLERY_NOTICE_UNRECOGNIZED"],
  ["guard registration fails", { guardFailure: true }, "GALLERY_NOTICE_READ_GUARD_FAILED"],
  ["known service worker", { workers: [{}] }, "GALLERY_NOTICE_SERVICE_WORKER"],
  ["Close throws", { closeFailure: true }, "GALLERY_NOTICE_CLOSE_FAILED"],
  ["Close does not settle", { unsettled: true }, "GALLERY_NOTICE_CLOSE_UNCONFIRMED"],
])
  test(`${name} refuses generic dismissal and retains incomplete authority`, async () => {
    const f = courseAnnouncementFixture(options),
      result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostic.code, code);
    assert.equal(f.state.gallery, 0);
    assert.equal(f.state.mark, 0);
    if (!options.closeFailure && !options.unsettled) assert.equal(f.state.close, 0);
    assert.doesNotMatch(JSON.stringify(result), /private click|private guard|private network/);
  });
for (const method of ["", "post", null, "GET\nPOST"])
  test(`malformed method ${String(method)} fails closed without retaining request evidence`, async () => {
    const f = courseAnnouncementFixture({ duringClose: ({ send }) => send(method) });
    const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(result.diagnostic.code, "GALLERY_NOTICE_READ_GUARD_FAILED");
    assert.equal(f.state.abort, 1);
    assert.equal(f.state.gallery, 0);
  });
test("fallback failure is sticky and cannot silently authorize another Close", async () => {
  const f = courseAnnouncementFixture({
    fallbackFailure: true,
    duringClose: ({ send }) => send("GET"),
  });
  const first = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(first.diagnostic.code, "GALLERY_NOTICE_READ_GUARD_FAILED");
  assert.equal(f.state.abort, 1);
  const second = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(second.complete, false);
  assert.equal(f.state.close, 1);
});
test("unavailable guard APIs and unconfirmed service-worker absence prohibit Close", async () => {
  for (const api of ["route", "serviceWorkers", "context"]) {
    const f = courseAnnouncementFixture();
    if (api === "context") delete f.page.context;
    else delete f.context[api];
    const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(result.diagnostic.code, "GALLERY_NOTICE_READ_GUARD_FAILED");
    assert.equal(f.state.close, 0);
  }
  const f = courseAnnouncementFixture();
  f.context.serviceWorkers = () => null;
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).diagnostic.code,
    "GALLERY_NOTICE_READ_GUARD_FAILED",
  );
  assert.equal(f.state.close, 0);
});
test("known service worker arriving during dismissal invalidates discovery without security setting changes", async () => {
  const f = courseAnnouncementFixture({
    duringClose: ({ context }) => {
      context.serviceWorkers = () => [{}];
    },
  });
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_SERVICE_WORKER");
  assert.equal(f.state.gallery, 0);
});
test("non-NTULearn request keeps route chaining; absent popup retains an initialized guard", async () => {
  const f = courseAnnouncementFixture({
    duringClose: ({ send }) => send("POST", "https://provider.example/read"),
  });
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).complete,
    true,
  );
  assert.equal(f.state.fallback, 1);
  assert.equal(f.state.abort, 0);
  const absent = courseAnnouncementFixture({ shown: false });
  assert.equal(
    (await readKalturaMediaGallery({ page: absent.page, course: ANNOUNCEMENT_COURSE })).complete,
    true,
  );
  assert.equal(absent.state.routes, 1);
  assert.equal(absent.state.close, 0);
});
for (const heading of [
  "Consent required",
  "Sign in to your account",
  "Multi-factor authentication",
])
  test(`unknown/auth/consent heading ${heading} remains untouched`, async () => {
    const f = courseAnnouncementFixture({ heading });
    const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostic.code, "GALLERY_NOTICE_UNRECOGNIZED");
    assert.equal(f.state.close, 0);
    assert.equal(f.state.routes, 1);
  });
test("failed abort never falsely claims a write was blocked", async () => {
  const f = courseAnnouncementFixture({
    abortFailure: true,
    duringClose: ({ send }) => send("DELETE"),
  });
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_READ_GUARD_FAILED");
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /private abort uncertainty/);
});
test("malformed request URL and request accessor errors fail closed with private-safe evidence", async () => {
  const f = courseAnnouncementFixture({
    duringClose: ({ send }) => send("POST", "malformed-private-url"),
  });
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_READ_GUARD_FAILED");
  assert.equal(f.state.abort, 1);
  assert.doesNotMatch(JSON.stringify(result), /malformed-private-url/);
});

test("mixed alertdialog and announcement are multiple visible surfaces, never a Close authorization", async () => {
  const f = courseAnnouncementFixture(),
    original = f.page.locator;
  f.page.locator = (selector) =>
    selector.includes(":visible")
      ? {
          ...f.modals,
          count: async () =>
            f.state.shown ? (selector.includes('[role="alertdialog"]') ? 2 : 1) : 0,
        }
      : original(selector);
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_UNRECOGNIZED");
  assert.equal(f.state.close, 0);
});

test("failed Close absence keeps later course navigation refused in that owned context", async () => {
  const f = courseAnnouncementFixture({ unsettled: true });
  let navigations = 0;
  f.page.goto = async () => {
    navigations++;
  };
  const first = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(first.diagnostic.code, "GALLERY_NOTICE_CLOSE_UNCONFIRMED");
  f.state.shown = false;
  const second = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(second.complete, false);
  assert.equal(second.diagnostic.code, "GALLERY_NOTICE_CLOSE_UNCONFIRMED");
  assert.equal(navigations, 1);
});

test("absence authority cannot return green when a write is blocked during exhaustion read", async () => {
  const f = courseAnnouncementFixture();
  assert.equal(
    (await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE })).complete,
    true,
  );
  const none = {
    first() {
      return this;
    },
    count: async () => 0,
  };
  const original = f.page.locator;
  f.page.getByRole = () => none;
  f.page.getByText = () => none;
  f.page.frames = () => [];
  f.page.locator = (selector) =>
    selector === "body"
      ? {
          innerText: async () => {
            await f.send("POST");
            return "No more content items to load";
          },
        }
      : original(selector);
  const result = await readKalturaMediaGallery({ page: f.page, course: ANNOUNCEMENT_COURSE });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(f.state.abort, 1);
});
