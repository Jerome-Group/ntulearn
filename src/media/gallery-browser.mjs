import { courseUrl, isSignInUrl } from "../ntulearn/urls.mjs";
import { discoverMediaGallery, isMediaCourseEnabled } from "./gallery.mjs";
import { publicMediaError } from "./errors.mjs";

const MAX_GALLERY_PAGES = 100;
const GALLERY_TRIGGER = /media\s+gallery/i;
const MORE_CONTROL =
  /load\s+more|show\s+more|\bnext(?:\s+page)?\b|\bmore\s+(?:recordings?|videos?|items?)\b/i;
const PAGE_CONTROL = /\bpage\s*\d+\b|^\d+$/i;

export async function readKalturaMediaGallery({ page, course }) {
  if (!isMediaCourseEnabled(course)) return discoverMediaGallery({ course, pages: null });

  try {
    const surface = await openGallerySurface(page, course.courseId);
    const pages = await collectMediaGalleryPages({
      readPage: () => readGalleryPage(surface),
      clickLoadMore: () => clickGalleryMore(surface),
    });
    return discoverMediaGallery({ course, pages });
  } catch (error) {
    return inaccessibleGallery(publicError(error, page));
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
  let nextPaginationMode = "append";
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const read = await readPage();
    const page =
      read && typeof read === "object"
        ? { ...read, paginationMode: read.paginationMode ?? nextPaginationMode }
        : read;
    pages.push(page);
    if (page?.hasMore !== true) return pages;
    const advance = await clickLoadMore(page);
    if (!advance) {
      throw new Error(
        "Media Gallery pagination advertised another page but its control was unavailable.",
      );
    }
    nextPaginationMode = advance.mode ?? "append";
  }
  throw new Error(`Media Gallery pagination exceeded the ${maxPages}-page safety limit.`);
}

async function openGallerySurface(page, courseId) {
  if (!page || typeof page.goto !== "function") {
    throw new Error("Media Gallery needs the signed-in browser page.");
  }
  await page.goto(courseUrl(courseId), { waitUntil: "domcontentloaded" });

  const trigger = await findGalleryTrigger(page);
  if (!trigger) throw new Error("Kaltura Media Gallery LTI surface is not visible in the course.");

  const popup =
    typeof page.waitForEvent === "function"
      ? page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null)
      : null;
  await trigger.click();
  const opened = popup ? await popup : null;
  const surface = opened ?? page;
  if (typeof surface.waitForLoadState === "function") {
    await surface.waitForLoadState("domcontentloaded").catch(() => {});
  }
  return findGalleryFrame(surface);
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
        return frame;
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

async function readGalleryPage(surface) {
  if (typeof surface.evaluate !== "function") {
    throw new Error("Kaltura Media Gallery surface cannot be inspected.");
  }
  return surface.evaluate(extractGallerySnapshot);
}

async function clickGalleryMore(surface) {
  for (const role of ["button", "link"]) {
    const control = await firstEnabledControl(surface.getByRole(role, { name: MORE_CONTROL }));
    if (control) {
      const label = await controlLabel(control);
      await control.click();
      await waitForGalleryUpdate(surface);
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
      await control.click();
      await waitForGalleryUpdate(surface);
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

async function waitForGalleryUpdate(surface) {
  let previous = null;
  if (typeof surface.locator === "function") {
    const body = surface.locator("body");
    if (typeof body?.innerText === "function") {
      previous = await body.innerText().catch(() => null);
    }
  }
  if (previous === null && typeof surface.evaluate === "function") {
    previous = await surface.evaluate(() => document.body?.innerText ?? "").catch(() => null);
  }
  if (previous !== null && typeof surface.waitForFunction === "function") {
    await surface
      .waitForFunction((before) => (document.body?.innerText ?? "") !== before, previous, {
        timeout: 5_000,
      })
      .catch(() => {});
    return;
  }
  if (typeof surface.waitForTimeout === "function") await surface.waitForTimeout(250);
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

    const title =
      card.getAttribute?.("data-title") ??
      card.querySelector?.("[data-title],h1,h2,h3,h4")?.textContent?.trim() ??
      anchor.textContent?.trim() ??
      "";
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

  return {
    displayedCount: explicitTotals[0] ?? displayedCount(bodyText),
    entries,
    hasMore: hasMoreControl(),
  };
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
    return normalizedStatus ? true : null;
  }

  function displayedCount(text) {
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

function inaccessibleGallery(message) {
  const limitation = `Media Gallery discovery incomplete: ${message}.`;
  return {
    complete: false,
    verdict: "red",
    recordings: [],
    queue: [],
    displayedCount: null,
    discoveredCount: 0,
    limitations: [limitation],
    limitation,
  };
}

function publicError(error, page) {
  let currentUrl = "";
  try {
    currentUrl = typeof page?.url === "function" ? page.url() : "";
  } catch {
    // A closed page has no reliable URL; the sanitized browser error remains useful.
  }
  if (isSignInUrl(currentUrl)) {
    return "NTULearn session is not signed in; run npm run login, then retry Media Gallery discovery";
  }
  return publicMediaError(error);
}
