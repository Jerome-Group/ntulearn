// `document` belongs to the two functions below that Playwright serialises and runs inside the
// page rather than here. Declared once at the top because ESLint reads the directive per file.
/* global document */
import { openSignedInContext } from "../src/ntulearn/session.mjs";
import { comparableUrl, isFileShaped } from "./difference.mjs";

// What a course's content items carry, read off the pages the student's browser renders rather
// than off the bodies NTULearn's read API returns (#45). `docs/adr/0007` names this as the
// candidate authority and refuses to adopt it on one course's evidence; this is what tries it.
//
// It shares the saved session with the walk and nothing else — not the addresses, not the tree,
// not a single field name. It never calls the read API, so it never uses the XSRF token the
// session hands over; a page carries the cookies, and the token is what an API request adds.
//
// Taking the session whole is deliberate anyway. `openSignedInContext` will not return until it
// has captured that token, and a reader with its own quieter sign-in would be a second thing that
// can be wrong about whether the student is signed in — which is the one failure this must not
// invent, since it reports a course it cannot read as a failure.
const BASE_URL = "https://ntulearn.ntu.edu.sg";
const OUTLINE_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 15_000;
const REVEAL_ROUNDS = 20;
const TREE_DEPTH = 10;
const SETTLE_PAUSE_MS = 1000;
const POLL_MS = 500;
const PAGES_AT_A_TIME = 4;
const LABEL_LIMIT = 200;
const ELEMENT_LIMIT = 600;

export async function openRenderedPageReader(profilePath) {
  const { context } = await openSignedInContext(profilePath);
  return {
    read: (courseId) => readCourse(context, courseId),
    close: () => context.close(),
  };
}

async function readCourse(context, courseId) {
  const outline = await context.newPage();
  let course;
  try {
    course = await readOutline(outline, courseId);
  } finally {
    await outline.close();
  }

  const readItems = await readEveryItem(context, courseId, course.items);
  const onItems = readItems.flatMap((each) =>
    each.objects.map((object) => ({
      ...object,
      itemId: each.item.id,
      itemTitle: each.item.title,
      itemUrl: each.item.url,
    })),
  );

  return {
    course: course.title,
    items: readItems.length,
    objects: onItems.filter(isContent(course.chrome, onItems, readItems.length)),
    unreadableItems: readItems
      .filter((each) => each.reason)
      .map(({ item, reason }) => ({ url: item.url, reason })),
  };
}

// The outline is not assumed to be the whole tree: every page read is also asked which items it
// links to, and anything new joins the frontier. A folder that renders as its own page rather than
// as something the outline opens is reached this way and no other.
//
// On PS0002 it found nothing the scrolled outline did not already have. That is a result about one
// course rather than a reason to drop it, and the run across the nine is what settles whether it
// earns its place.
async function readEveryItem(context, courseId, fromOutline) {
  const seen = new Map(fromOutline.map((item) => [item.id, item]));
  const read = [];
  let frontier = fromOutline;

  for (let depth = 0; depth < TREE_DEPTH && frontier.length; depth += 1) {
    const done = await inPages(context, frontier, (page, item) => readItem(page, courseId, item));
    read.push(...done);

    frontier = [];
    for (const each of done) {
      for (const found of each.links) {
        if (seen.has(found.id)) continue;
        seen.set(found.id, found);
        frontier.push(found);
      }
    }
  }

  return read;
}

// The application, subtracted twice over, because Ultra renders a deep-linked item inside the
// whole of itself and half the furniture is not on the bare outline: the notification socket, the
// LTI placements and the Ally frames are on every item's page and no course's outline.
//
// So an address is furniture if the outline carried it, or if **every** item carries it. The
// second is bounded to what is not file-shaped: a file two items share is a real thing, and on a
// one-item course "every item" says nothing at all.
function isContent(chrome, objects, items) {
  const onEveryItem = new Set();
  if (items > 1) {
    const itemsPerUrl = new Map();
    for (const object of objects) {
      const url = withoutQuery(object.url);
      itemsPerUrl.set(url, (itemsPerUrl.get(url) ?? new Set()).add(object.itemId));
    }
    for (const [url, on] of itemsPerUrl) if (on.size === items) onEveryItem.add(url);
  }

  return (object) => {
    if (chrome.has(comparableUrl(object.url))) return false;
    return !onEveryItem.has(withoutQuery(object.url)) || isFileShaped(object.url);
  };
}

// Furniture is recognised without the query string even off NTULearn, where the comparison keeps
// it. The notification socket is the same `clientframe.html` on all twenty-seven items with a
// fresh `ver=` each time, so keeping the query makes twenty-seven distinct objects out of one
// piece of the application — while dropping it everywhere would make one object out of a course's
// whole set of Panopto recordings, which is why only this side does it.
function withoutQuery(url) {
  try {
    const { origin, pathname } = new URL(url, BASE_URL);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
}

// The outline is where the item set comes from, and the only place this can tell "the student
// cannot reach this course" from "this course is empty". Ultra answers both with a page that
// loads, so the test is whether any content item ever renders — and where none does, this throws
// rather than returning a course with no items. A run nobody watches is the reason: an empty
// course reported as a clean one is the failure that looks like success.
async function readOutline(page, courseId) {
  await page.goto(courseUrl(courseId), { waitUntil: "domcontentloaded" });

  // Waiting for a content item rather than for the page, because Ultra answers a course the
  // student cannot reach with a page that loads: the navigation, the course name, and no content.
  // A selector for the item link is what tells the two apart, and giving up on it is the failure.
  if (!(await waitForItems(page, courseId)).length) {
    throw new Error(
      `No content item rendered on ${courseId} within ${OUTLINE_TIMEOUT_MS / 1000}s; ` +
        `the browser ended at ${page.url()}`,
    );
  }

  await revealEverything(page, courseId);
  return {
    title: await page.title(),
    items: await itemsOn(page, courseId),
    chrome: await chromeOn(page),
  };
}

async function waitForItems(page, courseId) {
  const deadline = Date.now() + OUTLINE_TIMEOUT_MS;
  for (;;) {
    const items = await itemsOn(page, courseId);
    if (items.length || Date.now() > deadline) return items;
    await page.waitForTimeout(POLL_MS);
  }
}

// The outline hides its content two ways at once, and reaching an item means undoing both. A
// folder renders its children only once it is opened, and the list itself renders only as far as
// it has been scrolled — on PS0002 that was 27 items where the walk had 43, and everything from
// `Tutorial & Lab 9` onwards simply was not in the DOM.
//
// Bounded, because a control that reopens itself would otherwise be an unattended run that never
// ends. Nothing here submits anything: `aria-expanded` is what a disclosure widget carries, and a
// student's course outline has no other kind.
async function revealEverything(page, courseId) {
  let before = -1;
  for (let round = 0; round < REVEAL_ROUNDS; round += 1) {
    const closed = await page.$$('[aria-expanded="false"]');
    for (const control of closed)
      await control.click({ timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await scrollThrough(page);
    await page.waitForTimeout(SETTLE_PAUSE_MS);

    // Folders and items together, because a round that opens a folder holding only more folders
    // adds no item and is not finished.
    const after =
      (await page.$$("[aria-expanded]")).length + (await itemsOn(page, courseId)).length;
    if (!closed.length && after === before) return;
    before = after;
  }
}

// Every scrolling region to its end, which is what a student does to see the bottom of a list and
// is the one thing here that is not a click. A page that renders more when it is scrolled is
// rendering content; a page that renders more when it is clicked is being asked for something.
function scrollThrough(page) {
  return page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollHeight > element.clientHeight + 50)
        element.scrollTop = element.scrollHeight;
    }
  });
}

// Keyed off Ultra's own addresses rather than off a class name: the URL scheme is the part of this
// page a release note would mention, and the class names are the part that changes without one.
async function itemsOn(page, courseId) {
  const anchors = await page.$$eval(itemLinkSelector(courseId), (found) =>
    found.map((anchor) => ({ url: anchor.href, title: anchor.textContent })),
  );

  const items = new Map();
  for (const anchor of anchors) {
    const id = itemIdIn(anchor.url);
    if (!id || items.has(id)) continue;
    items.set(id, { id, url: anchor.url, title: clean(anchor.title) || id });
  }
  return [...items.values()];
}

// Everything an item's page shows that is not the item: the navigation, the logos, and the links
// to its siblings. Ultra renders a deep-linked item inside the whole application, so without this
// every item would report the entire course's furniture as objects it carries.
//
// The price is stated rather than hidden: an object that is genuinely on an item and also on the
// bare outline is subtracted with the furniture. `report.mjs` says so in the run's own document.
//
// Normalised the same way the comparison normalises, because Ultra writes a cache-busting query
// onto its own assets: the raw address of a logo differs between two page loads, and subtracting
// by it would leave the furniture standing on every item.
async function chromeOn(page) {
  return new Set((await harvest(page)).map((object) => comparableUrl(object.url)));
}

async function readItem(page, courseId, item) {
  try {
    const response = await page.goto(item.url, { waitUntil: "domcontentloaded" });
    if (response && !response.ok()) {
      return { item, objects: [], links: [], reason: `HTTP ${response.status()}` };
    }
    // Ultra polls while it is open, so idle is a hope rather than a promise. Waiting for it when
    // it comes and carrying on when it does not is the difference between a slow read and a run
    // that dies on one item of nine courses.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    // Scrolled but never clicked, unlike the outline. An item's page carries `aria-expanded` on
    // its file previews, so sweeping those would be this reader making the page load things a
    // student had not asked it to — which the report says in as many words that it never does.
    await scrollThrough(page);
    await page.waitForTimeout(SETTLE_PAUSE_MS);
    return { item, objects: await harvestEveryFrame(page), links: await itemsOn(page, courseId) };
  } catch (error) {
    return { item, objects: [], links: [], reason: error.message };
  }
}

// Every frame the browser will let this into, which is the same-origin ones. A cross-origin frame
// is recorded as the `<iframe>` its parent carries and read no further — the embedded player is
// found, and what the player itself loads is beyond this reader by construction.
async function harvestEveryFrame(page) {
  const objects = [];
  for (const frame of page.frames()) {
    const found = await harvest(frame).catch(() => null);
    if (!found) continue;
    const inside = frame === page.mainFrame() ? null : frame.url();
    objects.push(...found.map((object) => ({ ...object, frame: inside })));
  }
  return objects;
}

// Two passes over every element, because Ultra needs both. The DOM **property** first — `src` as a
// property is the address the browser resolved and would fetch, where the attribute is the string
// an author wrote, and whether those differ is the question `docs/adr/0007` leaves open.
//
// Then every attribute, because on Ultra the property is not enough and this was measured rather
// than guessed: a course's attached file renders as `<a data-ally-file-preview-url="…/xid-…">`
// with **no `href` at all**, and the preview beside it carries the same address in an
// `aria-controls`. An element-shaped reader walks straight past a course's actual attachments.
//
// This is still the rendered page and not the body. What is being read is the DOM Ultra built out
// of the body, after it resolved it — the attribute is on an element that only exists because the
// page ran.
function harvest(frame) {
  return frame.evaluate(
    ({ labelLimit, elementLimit }) => {
      const KINDS = {
        img: "image",
        a: "link",
        iframe: "iframe",
        object: "object",
        embed: "embed",
        video: "video",
        audio: "audio",
        source: "source",
        track: "track",
      };
      const ADDRESS_PROPERTIES = ["currentSrc", "src", "href", "data"];
      const URL_SHAPED = /https?:\/\/[^\s"'<>\\)]+|\/[^\s"'<>\\)]+/g;
      const FILE_SHAPED = /\/bbcswebdav\/|\/sessions\/|xid-/i;
      // Inline content rather than an address: there is nothing to fetch and nothing a sync could
      // have failed to bring across, and one base64 image is longer than the report it lands in.
      const NOT_AN_ADDRESS = /^(?:data|blob|javascript|about|mailto|tel):/i;
      // The application loading itself, never a course's object. A `<script>` and a `<link rel>`
      // are how Ultra arrives — CDN bundles, the Ally client, a stylesheet — and on this course
      // they were three quarters of everything the page appeared to carry.
      const MACHINERY = new Set(["script", "link", "style", "meta", "base"]);
      const found = [];

      const describe = (element) => ({
        label: (
          element.getAttribute("alt") ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, labelLimit),
        element: element.outerHTML.slice(0, elementLimit),
      });

      for (const element of document.querySelectorAll("*")) {
        const tag = element.tagName.toLowerCase();
        if (MACHINERY.has(tag)) continue;
        const seen = new Set();

        const resolved =
          KINDS[tag] &&
          ADDRESS_PROPERTIES.map((name) => element[name]).find(
            (value) => typeof value === "string" && value && !NOT_AN_ADDRESS.test(value),
          );
        if (resolved) {
          seen.add(resolved);
          found.push({ url: resolved, kind: KINDS[tag], ...describe(element) });
        }

        for (const attribute of element.attributes) {
          // `xmlns` is a namespace rather than a fetch, and every `<svg>` on the page carries one.
          if (attribute.name === "xmlns") continue;
          for (const [candidate] of attribute.value.matchAll(URL_SHAPED)) {
            if (NOT_AN_ADDRESS.test(candidate)) continue;
            // An absolute address wherever it sits, and a relative one only where it is shaped
            // like a file — the rest of what a class or an id happens to contain is not an
            // address at all, and this is the one place a slash means nothing in particular.
            const url = candidate.startsWith("http")
              ? candidate
              : FILE_SHAPED.test(candidate)
                ? new URL(candidate, document.baseURI).href
                : "";
            if (!url || seen.has(url)) continue;
            seen.add(url);
            found.push({ url, kind: `${tag}[${attribute.name}]`, ...describe(element) });
          }
        }
      }

      return found;
    },
    { labelLimit: LABEL_LIMIT, elementLimit: ELEMENT_LIMIT },
  );
}

// A page each, a few at a time. A page per item rather than one reused, so nothing an item's page
// left behind is read as the next item's.
async function inPages(context, items, read) {
  const done = [];
  for (let start = 0; start < items.length; start += PAGES_AT_A_TIME) {
    const batch = items.slice(start, start + PAGES_AT_A_TIME);
    done.push(
      ...(await Promise.all(
        batch.map(async (item) => {
          const page = await context.newPage();
          try {
            return await read(page, item);
          } finally {
            await page.close();
          }
        }),
      )),
    );
  }
  return done;
}

function courseUrl(courseId) {
  return `${BASE_URL}/ultra/courses/${courseId}/outline`;
}

function itemLinkSelector(courseId) {
  return `a[href*="/ultra/courses/${courseId}/"]`;
}

// A content item is `…/courses/<course>/<kind>/<item>` — `document`, `file`, `scorm`, and whatever
// else a Building Block brings. Everything the outline links to that is not one is either a course
// tool, which is `/outline/…`, or the course itself.
//
// The path only. `…/outline/message?recipientIds=_27476_1` and `…/outline/booksAndTools?parentId=`
// both carry an id in the query, and reading those as items is what a looser match would do.
const ITEM_PATH = /^\/ultra\/courses\/[^/]+\/(?!outline(?:\/|$))[^/]+\/(_\d+_\d+)(?:\/[^/]*)?$/;

function itemIdIn(url) {
  try {
    return new URL(url, BASE_URL).pathname.match(ITEM_PATH)?.[1] ?? "";
  } catch {
    return "";
  }
}

function clean(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
