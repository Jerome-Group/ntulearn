import { courseUrl, isSignInUrl } from "../ntulearn/urls.mjs";
import { discoverMediaGallery, isMediaCourseEnabled } from "./gallery.mjs";
import { setTimeout, clearTimeout } from "node:timers";
import { closeCourseAnnouncement, assertCourseAnnouncementGuard } from "./course-announcement.mjs";
import { galleryFailure, GALLERY_WAIT_LIMITS } from "./gallery-diagnostic.mjs";

const MAX_GALLERY_PAGES = 100;
const MAX_CONTENT_LOADS = 100;
const MAX_GALLERY_FRAME_POLLS = 60;
const MAX_GALLERY_SETTLE_POLLS = 40;
const GALLERY_TRIGGER = /(?:media\s+gallery|lecture\s+recordings?)/i;
const MORE_CONTROL =
  /load\s+more|show\s+more|\bnext(?:\s+page)?\b|\bmore\s+(?:recordings?|videos?|items?)\b/i;
const PAGE_CONTROL = /\bpage\s*\d+\b|^\d+$/i;
const MEDIA_DATE =
  /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s*,\s*(\d{4})\b(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i;
const MONTHS = new Map([
  ["january", "01"],
  ["february", "02"],
  ["march", "03"],
  ["april", "04"],
  ["may", "05"],
  ["june", "06"],
  ["july", "07"],
  ["august", "08"],
  ["september", "09"],
  ["october", "10"],
  ["november", "11"],
  ["december", "12"],
]);

export async function readKalturaMediaGallery({ page, course }) {
  if (!isMediaCourseEnabled(course)) return discoverMediaGallery({ course, pages: null });

  let stage = "opening";
  try {
    const surface = await openGallerySurface(page, course.courseId);
    if (!surface) {
      await assertCourseAnnouncementGuard(page);
      return absentGallery();
    }
    stage = "catalogue";
    await waitForGalleryCatalogue(surface);
    const pages = await collectMediaGalleryPages({
      readPage: () => guardedGalleryRead(page, () => readGalleryPage(surface)),
      clickLoadMore: (snapshot) =>
        guardedGalleryRead(page, () => clickGalleryMore(surface, snapshot)),
    });
    stage = "date-enrichment";
    const enrichedPages = await enrichGalleryDates({
      page,
      pages,
      baseUrl: typeof surface.url === "function" ? surface.url() : null,
    });
    await assertCourseAnnouncementGuard(page);
    return discoverMediaGallery({ course, pages: enrichedPages });
  } catch (error) {
    let cause = error;
    try {
      await assertCourseAnnouncementGuard(page);
    } catch (guardFailure) {
      cause = guardFailure;
    }
    const failure = galleryFailure(publicErrorCode(cause, page), { ...error?.diagnostic, stage });
    return inaccessibleGallery(failure);
  }
}

async function guardedGalleryRead(page, operation) {
  await assertCourseAnnouncementGuard(page);
  try {
    const result = await operation();
    await assertCourseAnnouncementGuard(page);
    return result;
  } catch (error) {
    await assertCourseAnnouncementGuard(page);
    throw error;
  }
}

export async function collectMediaGalleryPages({
  readPage,
  clickLoadMore,
  maxPages = MAX_GALLERY_PAGES,
}) {
  if (typeof readPage !== "function" || typeof clickLoadMore !== "function") {
    throw new Error("Media Gallery pagination needs page and Load More adapters.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error("Media Gallery pagination needs a positive page limit.");
  }

  const pages = [];
  let nextPaginationMode = "unknown";
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    let read;
    try {
      read = await readPage();
    } catch (error) {
      throw galleryFailure(
        error?.code?.startsWith("GALLERY_NOTICE_") ? error.code : "GALLERY_CATALOGUE_READ_FAILED",
        {
          pagesRead: pages.length,
          pageLimit: maxPages,
          snapshot: pages.at(-1),
        },
      );
    }
    const page =
      read && typeof read === "object"
        ? {
            ...read,
            paginationMode:
              read.paginationMode === "unknown" &&
              nextPaginationMode === "append" &&
              cumulativeGalleryGrowth(pages.at(-1), read)
                ? "append"
                : (read.paginationMode ?? nextPaginationMode),
          }
        : read;
    pages.push(page);
    if (page?.hasMore !== true) return pages;
    if (appendPageReachedDisplayedTotal(page)) {
      pages[pages.length - 1] = { ...page, hasMore: false };
      return pages;
    }
    let advance;
    try {
      advance = await clickLoadMore(page);
    } catch (error) {
      throw galleryFailure(error?.code ?? "GALLERY_PAGINATION_CLICK_FAILED", {
        ...error?.diagnostic,
        pagesRead: pages.length,
        pageLimit: maxPages,
        snapshot: page,
      });
    }
    if (!advance) {
      throw galleryFailure("GALLERY_PAGINATION_CONTROL_UNAVAILABLE", {
        pagesRead: pages.length,
        pageLimit: maxPages,
        snapshot: page,
      });
    }
    nextPaginationMode = advance.mode ?? "append";
  }
  throw galleryFailure("GALLERY_PAGINATION_LIMIT_REACHED", {
    pagesRead: pages.length,
    pageLimit: maxPages,
    snapshot: pages.at(-1),
  });
}

function cumulativeGalleryGrowth(previous, current) {
  if (
    previous?.hasMore !== true ||
    !Number.isSafeInteger(current.displayedCount) ||
    current.displayedCount < 0 ||
    previous.displayedCount !== current.displayedCount ||
    !Array.isArray(previous.entries) ||
    !Array.isArray(current.entries) ||
    !previous.entries.length ||
    current.entries.length <= previous.entries.length
  )
    return false;
  const earlier = previous.entries.map(galleryEntryIdentity);
  const later = current.entries.map(galleryEntryIdentity);
  if ([...earlier, ...later].some((identity) => typeof identity !== "string" || !identity.trim()))
    return false;
  const earlierIdentities = new Set(earlier),
    laterIdentities = new Set(later);
  return (
    earlierIdentities.size === earlier.length &&
    laterIdentities.size === later.length &&
    earlier.every((identity) => laterIdentities.has(identity))
  );
}

function appendPageReachedDisplayedTotal(page) {
  return (
    page?.paginationMode === "append" &&
    Number.isSafeInteger(page.displayedCount) &&
    page.displayedCount >= 0 &&
    Array.isArray(page.entries) &&
    page.entries.length >= page.displayedCount
  );
}

async function openGallerySurface(page, courseId) {
  if (!page || typeof page.goto !== "function") {
    throw new Error("Media Gallery needs the signed-in browser page.");
  }
  await guardedGalleryRead(page, () =>
    page.goto(courseUrl(courseId), { waitUntil: "domcontentloaded" }),
  );
  if (typeof page.waitForLoadState === "function") {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }
  await assertCourseAnnouncementGuard(page);
  await waitForCourseContent(page);
  await assertCourseAnnouncementGuard(page);
  await closeCourseAnnouncement(page);
  await loadLazyCourseContent(page);

  await assertCourseAnnouncementGuard(page);
  const trigger = await findGalleryTrigger(page);
  if (!trigger) return (await courseContentIsExhausted(page)) ? null : missingGallerySurface();

  const popup =
    typeof page.waitForEvent === "function"
      ? page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null)
      : null;
  try {
    await trigger.click({ timeout: GALLERY_WAIT_LIMITS.clickTimeoutMs });
  } catch (error) {
    throw galleryFailure(
      /intercepts pointer events/i.test(String(error?.message ?? ""))
        ? "GALLERY_TRIGGER_POINTER_INTERCEPTION"
        : "GALLERY_TRIGGER_CLICK_FAILED",
      { control: "trigger" },
    );
  }
  await assertCourseAnnouncementGuard(page);
  const opened = popup ? await popup : null;
  const surface = opened ?? page;
  if (typeof surface.waitForLoadState === "function") {
    await surface.waitForLoadState("domcontentloaded").catch(() => {});
  }
  return findGalleryFrame(surface);
}

async function courseContentIsExhausted(page) {
  if (typeof page.locator !== "function") return false;
  const controls = page.locator('button[data-analytics-id*="loadMoreButton"]');
  if ((await controls.count()) > 0) {
    const control = controls.first();
    if (await controlIsDisabled(control)) return true;
    return false;
  }
  const body = page.locator("body");
  const text = typeof body?.innerText === "function" ? await body.innerText().catch(() => "") : "";
  return /no more content items to load/i.test(text);
}

async function waitForCourseContent(page) {
  if (typeof page.waitForFunction !== "function") return;
  await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector('button[data-analytics-id*="loadMoreButton"]')) ||
        Boolean(document.querySelector("a[data-launch-handle]")) ||
        /no more content items to load|media gallery/i.test(document.body?.innerText ?? ""),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {});
}

async function loadLazyCourseContent(page) {
  if (typeof page.locator !== "function") return;

  const controls = page.locator('button[data-analytics-id*="loadMoreButton"]');
  for (let attempt = 0; attempt < MAX_CONTENT_LOADS; attempt += 1) {
    await assertCourseAnnouncementGuard(page);
    if ((await controls.count()) === 0) return;

    const control = controls.first();
    if (await controlIsDisabled(control)) return;

    const body = page.locator("body");
    const before =
      typeof body?.innerText === "function" ? await body.innerText().catch(() => null) : null;
    await control.evaluate((element) => element.click());
    await assertCourseAnnouncementGuard(page);
    if (before !== null && typeof page.waitForFunction === "function") {
      await page
        .waitForFunction((previous) => (document.body?.innerText ?? "") !== previous, before, {
          timeout: 5_000,
        })
        .catch(() => {});
    } else if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(250);
    }
  }

  throw new Error(`Course content pagination exceeded the ${MAX_CONTENT_LOADS}-page safety limit.`);
}

async function findGalleryTrigger(page) {
  const frames = [page, ...(page.frames?.() ?? [])];
  for (const frame of frames) {
    const candidates = [
      () => frame.getByRole("link", { name: GALLERY_TRIGGER }).first(),
      () => frame.getByRole("button", { name: GALLERY_TRIGGER }).first(),
      () => frame.getByText(GALLERY_TRIGGER).first(),
    ];
    for (const create of candidates) {
      const candidate = create();
      if ((await candidate.count()) > 0) return candidate;
    }
  }
  return null;
}

async function findGalleryFrame(surface) {
  for (let attempt = 0; attempt < MAX_GALLERY_FRAME_POLLS; attempt += 1) {
    const allFrames = surface.frames?.() ?? [];
    const mainFrame = surface.mainFrame?.();
    const childFrames = allFrames.filter((frame) => frame !== mainFrame && frame !== surface);
    const frames = [
      ...childFrames,
      ...(mainFrame ? [mainFrame] : []),
      ...(mainFrame ? [] : [surface]),
    ];
    for (const frame of frames) {
      const cards = frame.locator?.(
        'a[href*="/media/t/"], [data-entry-id], [data-kaltura-entry-id], [data-recording-id], [data-gallery-entry-id]',
      );
      if (cards && (await cards.count()) > 0) return frame;
      const bodyLocator = frame.locator?.("body");
      const body = bodyLocator ? await bodyLocator.innerText?.().catch(() => "") : "";
      if (frame !== surface && /media\s+gallery|load\s+more|show\s+more|total/i.test(body)) {
        const frameUrl = typeof frame.url === "function" ? frame.url() : "";
        if (/\/channel\//i.test(frameUrl)) return frame;
      }
      if (
        frame === surface &&
        /load\s+more|show\s+more|\b\d+\s+(?:recordings?|videos?|items?)\b/i.test(body)
      ) {
        return frame;
      }
    }
    if (typeof surface.waitForTimeout === "function") await surface.waitForTimeout(250);
  }
  throw new Error("Kaltura Media Gallery surface opened without a readable catalogue.");
}

async function waitForGalleryCatalogue(surface) {
  if (typeof surface?.waitForTimeout !== "function") return;

  let previous = null;
  for (let attempt = 0; attempt < MAX_GALLERY_SETTLE_POLLS; attempt += 1) {
    const current = await readGalleryPage(surface).catch(() => null);
    if (gallerySnapshotIsReadable(current) && gallerySnapshotsMatch(previous, current)) return;
    previous = current;
    await surface.waitForTimeout(250);
  }
}

function gallerySnapshotIsReadable(snapshot) {
  return (
    Array.isArray(snapshot?.entries) &&
    snapshot.entries.length > 0 &&
    snapshot.entries.every(
      (entry) =>
        typeof entry?.title === "string" && entry.title.trim() && !/^\d+$/.test(entry.title.trim()),
    )
  );
}

function gallerySnapshotsMatch(previous, current) {
  if (!previous || previous.displayedCount !== current?.displayedCount) return false;
  if (previous.hasMore !== current.hasMore) return false;
  if (previous.entries?.length !== current.entries?.length) return false;
  return current.entries.every((entry, index) => {
    const earlier = previous.entries[index];
    return (
      galleryEntryIdentity(entry) === galleryEntryIdentity(earlier) &&
      entry?.title === earlier?.title
    );
  });
}

async function readGalleryPage(surface) {
  if (typeof surface.evaluate !== "function") {
    throw new Error("Kaltura Media Gallery surface cannot be inspected.");
  }
  return surface.evaluate(extractGallerySnapshot);
}

async function enrichGalleryDates({ page, pages, baseUrl }) {
  const missing = pages
    .flatMap((galleryPage) => galleryPage.entries ?? [])
    .filter((entry) => !entry?.createdAt && !entry?.creationDate && !entry?.created);
  if (!missing.length || typeof page?.context !== "function" || !baseUrl) return pages;

  const detail = await page.context().newPage();
  const dates = new Map();
  try {
    for (const entry of missing) {
      await assertCourseAnnouncementGuard(page);
      if (typeof entry?.href !== "string" || !entry.href.trim()) continue;
      const target = new URL(entry.href, baseUrl).href;
      if (!dates.has(target)) {
        await detail.goto(target, { waitUntil: "domcontentloaded" });
        await assertCourseAnnouncementGuard(page);
        const body = await detail
          .locator("body")
          .innerText()
          .catch(() => "");
        await assertCourseAnnouncementGuard(page);
        dates.set(target, parseMediaDetailCreatedAt(body));
      }
      const createdAt = dates.get(target);
      if (createdAt) entry.createdAt = createdAt;
    }
  } finally {
    await detail.close();
  }
  return pages;
}

export function parseMediaDetailCreatedAt(text) {
  if (typeof text !== "string") return null;
  const match = text.match(MEDIA_DATE);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const hour = mediaHour(match[4], match[6]);
  const minute = match[5] ?? "00";
  return `${match[3]}-${month}-${day}T${hour}:${minute}:00`;
}

function mediaHour(value, meridiem) {
  if (!value) return "00";
  let hour = Number(value);
  if (!Number.isSafeInteger(hour) || hour < 1 || hour > 12) return "00";
  if (meridiem?.toLowerCase() === "pm" && hour < 12) hour += 12;
  if (meridiem?.toLowerCase() === "am" && hour === 12) hour = 0;
  return String(hour).padStart(2, "0");
}

async function clickGalleryMore(surface, previousPage) {
  for (const role of ["button", "link"]) {
    const control = await firstEnabledControl(surface.getByRole(role, { name: MORE_CONTROL }));
    if (control) {
      const label = await controlLabel(control);
      await advanceGallery(surface, control, previousPage, "more");
      return { mode: paginationMode(label) };
    }
  }

  for (const role of ["button", "link"]) {
    const controls = surface.getByRole(role, { name: PAGE_CONTROL });
    const count = await controls.count();
    let currentPage = null;
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (await isCurrentControl(control)) {
        currentPage = await pageNumber(control);
        break;
      }
    }
    if (currentPage === null) continue;
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if ((await pageNumber(control)) !== currentPage + 1) continue;
      if (!(await isEnabledControl(control))) continue;
      await advanceGallery(surface, control, previousPage, "numbered");
      return { mode: "replace" };
    }
  }
  return false;
}

async function firstEnabledControl(controls) {
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (await isEnabledControl(control)) {
      return control;
    }
  }
  return null;
}

async function controlLabel(control) {
  return [
    await control.textContent?.(),
    await control.getAttribute?.("aria-label"),
    await control.getAttribute?.("title"),
  ]
    .filter(Boolean)
    .join(" ");
}

function paginationMode(label) {
  return /load\s+more|show\s+more|\bmore\s+(?:recordings?|videos?|items?)\b|^\s*more\s*$/i.test(
    label,
  )
    ? "append"
    : "replace";
}

async function isEnabledControl(control) {
  if ((await control.getAttribute?.("aria-disabled")) === "true") return false;
  if ((await control.isDisabled?.()) === true) return false;
  return !(await isCurrentControl(control));
}

async function isCurrentControl(control) {
  const ariaCurrent = await control.getAttribute?.("aria-current");
  if (ariaCurrent && ariaCurrent !== "false") return true;
  if ((await control.getAttribute?.("data-current")) === "true") return true;
  return /(?:^|\s)(?:active|current|selected)(?:\s|$)/i.test(
    (await control.getAttribute?.("class")) ?? "",
  );
}

async function pageNumber(control) {
  const label = [
    await control.textContent?.(),
    await control.getAttribute?.("aria-label"),
    await control.getAttribute?.("data-page"),
    await control.getAttribute?.("title"),
  ]
    .filter(Boolean)
    .join(" ");
  const match = label.match(/(?:page\s*)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function advanceGallery(surface, control, previousPage, kind) {
  try {
    await control.click({ timeout: GALLERY_WAIT_LIMITS.clickTimeoutMs });
  } catch {
    throw galleryFailure("GALLERY_PAGINATION_CLICK_FAILED", { control: kind });
  }
  if (!(await waitForGalleryUpdate(surface, previousPage))) {
    throw galleryFailure("GALLERY_PAGINATION_UPDATE_UNCONFIRMED", { control: kind });
  }
}

async function waitForGalleryUpdate(surface, previousPage) {
  if (!previousPage || typeof surface.evaluate !== "function") return false;
  let timer;
  let stopped = false;
  const deadline = Date.now() + GALLERY_WAIT_LIMITS.updateTimeoutMs;
  const observe = async () => {
    while (!stopped && Date.now() < deadline) {
      const current = await readGalleryPage(surface).catch(() => null);
      if (stopped || Date.now() >= deadline) return false;
      if (galleryPageAdvanced(previousPage, current)) return true;
      if (typeof surface.waitForTimeout !== "function") return false;
      await surface.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return false;
  };
  try {
    return await Promise.race([
      observe().catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), GALLERY_WAIT_LIMITS.updateTimeoutMs);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}

function galleryPageAdvanced(previous, current) {
  if (!current || !Array.isArray(current.entries)) return false;
  if (!Array.isArray(previous?.entries)) return false;
  if (current.displayedCount !== previous.displayedCount) return true;
  if (current.hasMore !== previous.hasMore) return true;
  if (current.entries.length !== previous.entries?.length) return true;
  return current.entries.some(
    (entry, index) => galleryEntryIdentity(entry) !== galleryEntryIdentity(previous.entries[index]),
  );
}

function galleryEntryIdentity(entry) {
  return entry?.id ?? entry?.providerReference ?? entry?.href ?? null;
}

/* global document */
export function extractGallerySnapshot() {
  const moreControl =
    /load\s+more|show\s+more|\bnext(?:\s+page)?\b|\bmore\s+(?:recordings?|videos?|items?)\b/i;
  const pageControl = /\bpage\s*\d+\b|^\d+$/i;
  const bodyText = document.body?.innerText ?? "";
  const explicitTotals = [
    ...document.querySelectorAll("[data-total-count],[data-total],[data-recording-count]"),
  ]
    .map((element) =>
      Number(
        element.getAttribute("data-total-count") ??
          element.getAttribute("data-total") ??
          element.getAttribute("data-recording-count"),
      ),
    )
    .filter(Number.isSafeInteger);
  const cards = [
    ...document.querySelectorAll(
      'a[href*="/media/t/"], [data-entry-id], [data-kaltura-entry-id], [data-recording-id], [data-gallery-entry-id]',
    ),
  ];
  const entries = [];
  const seenCards = new Set();
  const usedIdentities = new Set();

  for (const anchor of cards) {
    const card =
      anchor.closest?.(
        "article,li,[role='article'],[class*='card'],[class*='media-item'],[data-testid*='card'],[data-testid*='entry']",
      ) ?? anchor;
    if (seenCards.has(card)) continue;
    seenCards.add(card);
    const href = anchor.getAttribute?.("href") ?? card.getAttribute?.("href") ?? null;
    const entryId =
      card.getAttribute?.("data-entry-id") ??
      card.getAttribute?.("data-kaltura-entry-id") ??
      card.getAttribute?.("data-recording-id") ??
      card.getAttribute?.("data-gallery-entry-id") ??
      anchor.getAttribute?.("data-entry-id") ??
      null;
    const stableHref = href?.split(/[?#]/, 1)[0] ?? null;
    const baseIdentity =
      card.getAttribute?.("data-appearance-id") ?? stableHref ?? entryId ?? "gallery-entry";
    const identity = usedIdentities.has(baseIdentity)
      ? `${baseIdentity}:${entries.length}`
      : baseIdentity;
    usedIdentities.add(identity);

    const title = galleryTitle(card, anchor);
    const createdAt =
      card.getAttribute?.("data-created-at") ??
      card.getAttribute?.("data-creation-date") ??
      card.querySelector?.("time[datetime]")?.getAttribute?.("datetime") ??
      null;
    const status = card.getAttribute?.("data-status") ?? "";
    const mediaType =
      card.getAttribute?.("data-media-type") ??
      (/\baudio\b/i.test(card.innerText ?? "") ? "audio" : "video");
    const duration = card.getAttribute?.("data-duration") ?? null;

    entries.push({
      id: identity,
      providerReference: entryId ? safeEntryReference(entryId) : null,
      href,
      title,
      createdAt,
      duration,
      mediaType,
      status,
      visible: visibleValue(card),
      published: publishedValue(card, status),
    });
  }

  const hasExplicitTotal = explicitTotals.length > 0;
  const total = hasExplicitTotal ? explicitTotals[0] : displayedCount(bodyText);
  const displayedTotalIsFullyLoaded =
    Number.isSafeInteger(total) &&
    total >= 0 &&
    entries.length >= total &&
    new RegExp(`\\b${total}\\s+of\\s+${total}\\b`, "i").test(bodyText);
  return {
    displayedCount: total,
    entries,
    hasMore: hasMoreControl(),
    paginationMode: hasExplicitTotal || displayedTotalIsFullyLoaded ? "append" : "unknown",
  };
  function galleryTitle(card, anchor) {
    const explicit = card.getAttribute?.("data-title")?.trim();
    if (explicit) return explicit;

    const lines = titleLines(card.innerText);
    const recordingLinks = [anchor, ...(card.querySelectorAll?.('a[href*="/media/t/"]') ?? [])];
    const linkTitle = recordingLinks
      .map((link) =>
        titleLines(link.innerText ?? link.textContent).filter((line) =>
          isReadableTitleLine(line, { allowNumeric: true }),
        ),
      )
      .flat()
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)[0];
    if (linkTitle) return linkTitle;

    const readable = [...lines].reverse().find(isReadableTitleLine);
    return (
      readable ??
      card.querySelector?.("[data-title],h1,h2,h3,h4")?.textContent?.trim() ??
      anchor.textContent?.trim() ??
      ""
    );
  }
  function titleLines(text) {
    return String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  function isReadableTitleLine(line, { allowNumeric = false } = {}) {
    return (
      !/\bduration\b/i.test(line) &&
      !/^\d{1,2}:\d{2}(?::\d{2})?/.test(line) &&
      (allowNumeric || !/^\d+$/.test(line)) &&
      !/^\d+\s+(?:plays?|comments?|likes?)\b/i.test(line) &&
      !/\b\d+\s+of\s+\d+\s*$/i.test(line)
    );
  }
  function safeEntryReference(value) {
    const reference = String(value)
      .trim()
      .split(/[?#&\s]/, 1)[0];
    return reference ? `entry:${reference}` : null;
  }

  function visibleValue(card) {
    let current = card;
    while (current) {
      if (current.getAttribute?.("aria-hidden") === "true" || current.hasAttribute?.("hidden")) {
        return false;
      }
      const style = current.getAttribute?.("style")?.toLowerCase() ?? "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return false;
      const className = current.getAttribute?.("class")?.toLowerCase() ?? "";
      if (/(?:^|\s)(?:hidden|d-none|invisible)(?:\s|$)/.test(className)) return false;
      current = current.parentElement;
    }
    return true;
  }

  function publishedValue(card, status) {
    const normalizedStatus = status.trim().toLowerCase();
    if (
      [
        "unpublished",
        "not published",
        "draft",
        "private",
        "hidden",
        "not available",
        "not visible",
      ].includes(normalizedStatus)
    ) {
      return false;
    }
    if (
      normalizedStatus &&
      !["published", "available", "visible", "active"].includes(normalizedStatus)
    ) {
      return null;
    }
    const label = `${card.getAttribute?.("aria-label") ?? ""} ${card.innerText ?? ""}`;
    if (
      /\b(?:unpublished|not\s+published|draft|private|hidden|not\s+available|not\s+visible)\b/i.test(
        label,
      )
    ) {
      return false;
    }
    const published = card.getAttribute?.("data-published");
    if (published !== null) {
      if (["false", "0", "unpublished", "draft", "private"].includes(published.toLowerCase())) {
        return false;
      }
      if (["true", "1", "published", "available"].includes(published.toLowerCase())) return true;
      return null;
    }
    if (/\b(?:published|available|visible)\b/i.test(label)) return true;
    if (hasMediaLink(card)) return true;
    return normalizedStatus ? true : null;
  }

  function hasMediaLink(card) {
    return (
      /\/media\/t(?:\/|$)/i.test(card.getAttribute?.("href") ?? "") ||
      Boolean(card.querySelector?.('a[href*="/media/t/"]'))
    );
  }

  function displayedCount(text) {
    const media = text.match(/\b(\d+)\s+media\b/i)?.[1];
    if (media !== undefined) return Number(media);
    const explicit =
      text.match(/(?:of|total(?:\s+recordings?)?)\s*[:#]?\s*(\d+)/i)?.[1] ??
      text.match(/\b(\d+)\s+(?:recordings?|videos?|items?)\b/i)?.[1];
    return explicit === undefined ? null : Number(explicit);
  }

  function hasMoreControl() {
    const controls = [...document.querySelectorAll("button,a,[role='button']")];
    if (controls.some((control) => isEnabledControl(control, moreControl))) return true;
    const current = controls.find((control) => isCurrentControl(control));
    const currentPage = current ? pageNumber(current) : null;
    return (
      currentPage !== null &&
      controls.some(
        (control) =>
          pageNumber(control) === currentPage + 1 && isEnabledControl(control, pageControl),
      )
    );
  }

  function isEnabledControl(control, matcher) {
    const label = controlLabel(control);
    return (
      matcher.test(label) &&
      !isCurrentControl(control) &&
      control.getAttribute?.("aria-disabled") !== "true" &&
      !control.hasAttribute?.("disabled")
    );
  }

  function isCurrentControl(control) {
    const ariaCurrent = control.getAttribute?.("aria-current");
    if (ariaCurrent && ariaCurrent !== "false") return true;
    if (control.getAttribute?.("data-current") === "true") return true;
    return /(?:^|\s)(?:active|current|selected)(?:\s|$)/i.test(
      control.getAttribute?.("class") ?? "",
    );
  }

  function pageNumber(control) {
    const match = controlLabel(control).match(/(?:page\s*)?(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function controlLabel(control) {
    return [
      control.textContent?.trim() ?? "",
      control.getAttribute?.("aria-label") ?? "",
      control.getAttribute?.("data-page") ?? "",
      control.getAttribute?.("title") ?? "",
      control.getAttribute?.("data-testid") ?? "",
    ].join(" ");
  }
}

function inaccessibleGallery(error) {
  const limitation = `Media Gallery discovery incomplete: ${error.message}`;
  return {
    complete: false,
    verdict: "red",
    diagnostic: error.diagnostic,
    recordings: [],
    queue: [],
    displayedCount: null,
    discoveredCount: 0,
    limitations: [limitation],
    limitation,
  };
}

function absentGallery() {
  return {
    complete: true,
    verdict: "green",
    recordings: [],
    queue: [],
    displayedCount: 0,
    discoveredCount: 0,
    limitations: ["No Kaltura Media Gallery LTI surface is present in the fully loaded course."],
    limitation: "No Kaltura Media Gallery LTI surface is present in the fully loaded course.",
    galleryAvailable: false,
  };
}

function missingGallerySurface() {
  throw new Error(
    "Kaltura Media Gallery LTI surface is not visible after course content loaded; run media discovery again after confirming the signed-in course page exposes Media Gallery.",
  );
}

async function controlIsDisabled(control) {
  if ((await control.isDisabled?.()) === true) return true;
  return (await control.getAttribute?.("aria-disabled")) === "true";
}

function publicErrorCode(error, page) {
  let currentUrl = "";
  try {
    currentUrl = typeof page?.url === "function" ? page.url() : "";
  } catch {
    // A closed page cannot establish session state.
  }
  if (isSignInUrl(currentUrl)) {
    return "GALLERY_SESSION_UNAVAILABLE";
  }
  return error?.code ?? "GALLERY_DISCOVERY_FAILED";
}
