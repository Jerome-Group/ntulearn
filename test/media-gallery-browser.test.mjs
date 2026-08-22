import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  collectMediaGalleryPages,
  extractGallerySnapshot,
  parseMediaDetailCreatedAt,
  readKalturaMediaGallery,
} from "../src/media/gallery-browser.mjs";

const COURSE = {
  key: "MH1101",
  courseId: "_9_1",
  destination: "/courses/MH1101/NTULearn",
  mediaMode: "pilot",
};

test("collects every gallery page through the visible load-more control", async () => {
  const pages = [
    { displayedCount: 2, entries: [{ id: "gallery-1" }], hasMore: true },
    { displayedCount: 2, entries: [{ id: "gallery-2" }], hasMore: false },
  ];
  const clicks = [];

  const result = await collectMediaGalleryPages({
    async readPage() {
      return pages[clicks.length];
    },
    async clickLoadMore() {
      clicks.push("load-more");
      return true;
    },
  });

  assert.equal(result.length, 2);
  assert.deepEqual(clicks, ["load-more"]);
});

test("stops cumulative Load More pagination when the displayed total is reached", async () => {
  let clicks = 0;
  const first = { id: "gallery-1" };
  const second = { id: "gallery-2" };

  const result = await collectMediaGalleryPages({
    async readPage() {
      return clicks === 0
        ? { displayedCount: 2, entries: [first], hasMore: true }
        : { displayedCount: 2, entries: [first, second], hasMore: true };
    },
    async clickLoadMore() {
      clicks += 1;
      return clicks === 1 ? { mode: "append" } : false;
    },
  });

  assert.equal(clicks, 1);
  assert.equal(result.at(-1).hasMore, false);
  assert.equal(result.at(-1).entries.length, 2);
});

test("treats an initial cumulative Gallery page at its displayed total as exhausted", async () => {
  let clicks = 0;

  const result = await collectMediaGalleryPages({
    async readPage() {
      return {
        paginationMode: "append",
        displayedCount: 2,
        entries: [{ id: "gallery-1" }, { id: "gallery-2" }],
        hasMore: true,
      };
    },
    async clickLoadMore() {
      clicks += 1;
      return false;
    },
  });

  assert.equal(clicks, 0);
  assert.equal(result.at(-1).hasMore, false);
});

test("does not trust a page-sized count before cumulative pagination is confirmed", async () => {
  let clicks = 0;
  const first = { id: "gallery-1" };
  const second = { id: "gallery-2" };

  const result = await collectMediaGalleryPages({
    async readPage() {
      return clicks === 0
        ? { displayedCount: 1, entries: [first], hasMore: true }
        : { displayedCount: 2, entries: [first, second], hasMore: false };
    },
    async clickLoadMore() {
      clicks += 1;
      return { mode: "append" };
    },
  });

  assert.equal(clicks, 1);
  assert.equal(result.at(-1).entries.length, 2);
});

test("fails when a gallery advertises more pages but its control cannot advance", async () => {
  await assert.rejects(
    collectMediaGalleryPages({
      async readPage() {
        return { displayedCount: 1, entries: [], hasMore: true };
      },
      async clickLoadMore() {
        return false;
      },
    }),
    /pagination/i,
  );
});

test("evaluates the Gallery snapshot without Node-side helper closures", () => {
  const first = galleryCard("shared", "One", "shared-one");
  const second = galleryCard("shared", "Two", "shared-two");
  const total = galleryElement({ "data-total-count": "2" });
  const more = galleryElement({ disabled: "" }, "Load more");
  const document = {
    body: { innerText: "2 recordings" },
    querySelectorAll(selector) {
      if (selector.startsWith("[data-total")) return [total];
      if (selector === "button,a,[role='button']") return [more];
      return [first.anchor, second.anchor];
    },
  };

  const result = runInNewContext(`(${extractGallerySnapshot.toString()})()`, { document });

  assert.equal(result.displayedCount, 2);
  assert.equal(result.paginationMode, "append");
  assert.equal(result.hasMore, false);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(result.entries.map(({ id, providerReference }) => [id, providerReference])),
    ),
    [
      ["/media/t/shared-one", "entry:shared"],
      ["/media/t/shared-two", "entry:shared"],
    ],
  );
});

test("continues when an enabled Gallery control contradicts the displayed total", () => {
  const card = galleryElement({ "data-title": "Lecture" }, "Lecture");
  const anchor = galleryElement({ href: "/media/t/entry-one/176282" }, "Lecture");
  anchor.closest = () => card;
  const more = galleryElement({}, "Load more");
  const document = {
    body: { innerText: "1 Media" },
    querySelectorAll(selector) {
      if (selector.startsWith("[data-total")) return [];
      if (selector === "button,a,[role='button']") return [more];
      return [anchor];
    },
  };

  const result = runInNewContext(`(${extractGallerySnapshot.toString()})()`, { document });

  assert.equal(result.displayedCount, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.hasMore, true);
});

test("reads live Kaltura channel links and the total media count", () => {
  const card = galleryElement(
    {
      "data-created-at": "2026-08-10T09:00:00+08:00",
      "data-title": "Lecture",
    },
    "Lecture",
  );
  const anchor = galleryElement({ href: "/media/t/entry-one/176282" }, "Lecture");
  anchor.closest = () => card;
  card.querySelector = (selector) => (selector === 'a[href*="/media/t/"]' ? anchor : null);
  const document = {
    body: { innerText: "27 Media\nLecture 1 of 15" },
    querySelectorAll(selector) {
      if (selector.startsWith("[data-total")) return [];
      if (selector === "button,a,[role='button']") return [];
      return [anchor];
    },
  };

  const result = runInNewContext(`(${extractGallerySnapshot.toString()})()`, { document });

  assert.equal(result.displayedCount, 27);
  assert.equal(result.entries[0].published, true);
  assert.equal(result.entries[0].href, "/media/t/entry-one/176282");
});

test("normalizes the date shown on a Kaltura media detail page", () => {
  assert.equal(
    parseMediaDetailCreatedAt("From Instructor 16 April, 2026 0 likes"),
    "2026-04-16T00:00:00",
  );
  assert.equal(
    parseMediaDetailCreatedAt("From Instructor 16 April, 2026 at 9:30 PM"),
    "2026-04-16T21:30:00",
  );
  assert.equal(parseMediaDetailCreatedAt("No creation date"), null);
});

test("rejects contradictory publication evidence", () => {
  const card = galleryCard("shared", "Not published");
  card.card.innerText = "Not published";
  const document = {
    body: { innerText: "1 recording" },
    querySelectorAll(selector) {
      if (selector.startsWith("[data-total")) return [];
      if (selector === "button,a,[role='button']") return [];
      return [card.anchor];
    },
  };

  const result = runInNewContext(`(${extractGallerySnapshot.toString()})()`, { document });

  assert.equal(result.entries[0].published, false);
});

test("does not treat unrelated More options controls as pagination", () => {
  const moreOptions = galleryElement({}, "More options");
  const document = {
    body: { innerText: "1 recording" },
    querySelectorAll(selector) {
      if (selector === "button,a,[role='button']") return [moreOptions];
      return [];
    },
  };

  const result = runInNewContext(`(${extractGallerySnapshot.toString()})()`, { document });

  assert.equal(result.hasMore, false);
});

test("selects a readable child LTI frame and preserves its reconciled catalogue", async () => {
  const trigger = locator({ count: 1, click: async () => {} });
  const child = {
    locator: () => locator({ count: 1 }),
    evaluate: async () => ({
      displayedCount: 1,
      entries: [
        {
          id: "appearance-1",
          providerReference: "entry:one",
          title: "Lecture",
          createdAt: "2026-08-10T09:00:00+08:00",
          visible: true,
          published: true,
        },
      ],
      hasMore: false,
    }),
    getByRole: () => locator({ count: 0 }),
  };
  const outer = { locator: () => locator({ count: 0 }) };
  let frameReads = 0;
  const page = {
    async goto() {},
    frames: () => (++frameReads < 3 ? [outer] : [outer, child]),
    mainFrame: () => outer,
    getByRole: () => trigger,
    getByText: () => trigger,
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(result.complete, true);
  assert.equal(result.recordings[0].galleryEntryId, "appearance-1");
});

test("loads lazy course content before opening the Media Gallery link", async () => {
  let contentLoaded = false;
  const trigger = locator({ count: 1, click: async () => {} });
  const loadMore = {
    async count() {
      return contentLoaded ? 0 : 1;
    },
    first() {
      return this;
    },
    async evaluate() {
      contentLoaded = true;
    },
  };
  const child = {
    locator: () => locator({ count: 1 }),
    evaluate: async () => ({
      displayedCount: 1,
      entries: [
        {
          id: "appearance-1",
          providerReference: "entry:one",
          title: "Lecture",
          createdAt: "2026-08-10T09:00:00+08:00",
          visible: true,
          published: true,
        },
      ],
      hasMore: false,
    }),
    getByRole: () => locator({ count: 0 }),
  };
  const outer = { locator: () => locator({ count: 0 }) };
  const page = {
    async goto() {},
    locator(selector) {
      if (selector.includes("loadMoreButton")) return loadMore;
      return locator({ count: 0 });
    },
    frames: () => [outer, child],
    mainFrame: () => outer,
    getByRole: () => trigger,
    getByText: () => trigger,
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(contentLoaded, true);
  assert.equal(result.complete, true);
});

test("treats an exhausted course without a Media Gallery link as an empty gallery", async () => {
  const page = {
    async goto() {},
    locator(selector) {
      if (selector.includes("loadMoreButton")) return locator({ count: 0 });
      if (selector === "body") {
        return {
          async innerText() {
            return "Course Content\\nNo more content items to load";
          },
        };
      }
      return locator({ count: 0 });
    },
    frames: () => [],
    getByRole: () => locator({ count: 0 }),
    getByText: () => locator({ count: 0 }),
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(result.complete, true);
  assert.equal(result.galleryAvailable, false);
  assert.deepEqual(result.recordings, []);
});

test("advances a numbered Gallery page from the identified current page", async () => {
  let currentPage = 1;
  const pageOne = pageEntry("gallery-1", "entry:one", true);
  const pageTwo = pageEntry("gallery-2", "entry:two", false);
  const current = pageControl("Page 1", { "aria-current": "page" });
  const next = pageControl("Go to page 2");
  const child = {
    locator: () => locator({ count: 1 }),
    evaluate: async () =>
      currentPage === 1
        ? { displayedCount: 2, entries: [pageOne], hasMore: true }
        : { displayedCount: 2, entries: [pageTwo], hasMore: false },
    getByRole(role, { name }) {
      if (role === "button" && name.test("Page 1")) {
        return collectionLocator([current, next], () => {
          currentPage = 2;
        });
      }
      return locator({ count: 0 });
    },
  };
  const outer = { locator: () => locator({ count: 0 }) };
  const page = {
    async goto() {},
    frames: () => [outer, child],
    mainFrame: () => outer,
    getByRole: () => locator({ count: 1, click: async () => {} }),
    getByText: () => locator({ count: 1, click: async () => {} }),
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(result.complete, true);
  assert.equal(result.discoveredCount, 2);
  assert.equal(currentPage, 2);
});

test("waits for a Gallery page to advance before reading its next state", async () => {
  let currentPage = 1;
  let clicks = 0;
  const pageOne = pageEntry("gallery-1", "entry:one", true);
  const pageTwo = pageEntry("gallery-2", "entry:two", false);
  const current = pageControl("Page 1", { "aria-current": "page" });
  const next = pageControl("Go to page 2");
  const child = {
    locator: () => locator({ count: 1 }),
    evaluate: async () =>
      currentPage === 1
        ? { displayedCount: 2, entries: [pageOne], hasMore: true }
        : { displayedCount: 2, entries: [pageTwo], hasMore: false },
    getByRole(role, { name }) {
      if (role === "button" && name.test("Page 1")) {
        return collectionLocator([current, next], () => {
          clicks += 1;
          setTimeout(1_000).then(() => {
            currentPage = 2;
          });
        });
      }
      return locator({ count: 0 });
    },
    async waitForTimeout(delay) {
      await setTimeout(delay);
    },
  };
  const outer = { locator: () => locator({ count: 0 }) };
  const page = {
    async goto() {},
    frames: () => [outer, child],
    mainFrame: () => outer,
    getByRole: () => locator({ count: 1, click: async () => {} }),
    getByText: () => locator({ count: 1, click: async () => {} }),
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(result.complete, true);
  assert.equal(clicks, 1);
});

test("turns an identity-provider stall into an actionable session limitation", async () => {
  const page = {
    async goto() {
      throw new Error("navigation timed out");
    },
    url: () => "https://login.microsoftonline.com/common/oauth2/authorize",
  };

  const result = await readKalturaMediaGallery({ page, course: COURSE });

  assert.equal(result.complete, false);
  assert.match(result.limitation, /npm run login/);
});

function galleryCard(entryId, title, linkId = entryId) {
  const card = galleryElement(
    {
      "data-gallery-entry-id": entryId,
      "data-title": title,
      "data-created-at": "2026-08-10T09:00:00+08:00",
      "data-published": "true",
    },
    title,
  );
  const anchor = galleryElement({ href: `/media/t/${linkId}` }, title);
  anchor.closest = () => card;
  card.querySelector = () => null;
  return { card, anchor };
}

function pageEntry(id, providerReference, hasMore) {
  return {
    id,
    providerReference,
    title: id,
    createdAt: "2026-08-10T09:00:00+08:00",
    visible: true,
    published: true,
    hasMore,
  };
}

function pageControl(text, attributes = {}) {
  return {
    async textContent() {
      return text;
    },
    async getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    async isDisabled() {
      return false;
    },
  };
}

function collectionLocator(items, onClick) {
  return {
    async count() {
      return items.length;
    },
    nth(index) {
      const item = items[index];
      return {
        ...item,
        async click() {
          if (index === 1) onClick();
        },
      };
    },
  };
}

function galleryElement(attributes, text = "") {
  return {
    innerText: text,
    textContent: text,
    parentElement: null,
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(attributes, name);
    },
    querySelector: () => null,
  };
}

function locator({ count, click = async () => {} }) {
  return {
    first() {
      return this;
    },
    async count() {
      return count;
    },
    async click() {
      await click();
    },
    async getAttribute() {
      return null;
    },
    async isDisabled() {
      return false;
    },
  };
}
