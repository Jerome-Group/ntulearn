import { openSignedInContext } from "../src/ntulearn/session.mjs";
import { comparableUrl } from "./difference.mjs";

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
const EXPANSION_ROUNDS = 20;
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

  const readItems = await inPages(context, course.items, (page, item) => readItem(page, item));
  return {
    course: course.title,
    items: readItems.length,
    objects: readItems.flatMap((each) =>
      each.objects
        .filter((object) => !course.chrome.has(comparableUrl(object.url)))
        .map((object) => ({
          ...object,
          itemId: each.item.id,
          itemTitle: each.item.title,
          itemUrl: each.item.url,
        })),
    ),
    unreadableItems: readItems
      .filter((each) => each.reason)
      .map(({ item, reason }) => ({ url: item.url, reason })),
  };
}

// The outline is where the item set comes from, and the only place this can tell "the student
// cannot reach this course" from "this course is empty". Ultra answers both with a page that
// loads, so the test is whether any content item ever renders — and where none does, this throws
// rather than returning a course with no items. A run nobody watches is the reason: an empty
// course reported as a clean one is the failure that looks like success.
async function readOutline(page, courseId) {
  await page.goto(courseUrl(courseId), { waitUntil: "domcontentloaded" });
  const links = itemLinkSelector(courseId);
  try {
    await page.waitForSelector(links, { timeout: OUTLINE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(
      `No content item rendered on ${courseId} within ${OUTLINE_TIMEOUT_MS / 1000}s; ` +
        `the browser ended at ${page.url()}`,
      { cause: error },
    );
  }

  await expandEverything(page, links);
  const items = await itemsOn(page, courseId);
  if (!items.length) throw new Error(`The outline of ${courseId} rendered no readable item link`);

  return { title: await page.title(), items, chrome: await chromeOn(page) };
}

// A folder or a learning module renders its children only once it is open, so everything closed is
// clicked until nothing closed is left. Bounded, because a control that reopens itself would
// otherwise be an unattended run that never ends.
async function expandEverything(page, links) {
  for (let round = 0; round < EXPANSION_ROUNDS; round += 1) {
    const closed = await page.$$('[aria-expanded="false"]');
    if (!closed.length) return;

    const before = (await page.$$(links)).length;
    for (const control of closed)
      await control.click({ timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
    if ((await page.$$(links)).length === before) return;
  }
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

async function readItem(page, item) {
  try {
    const response = await page.goto(item.url, { waitUntil: "domcontentloaded" });
    if (response && !response.ok()) {
      return { item, objects: [], reason: `HTTP ${response.status()}` };
    }
    // Ultra polls while it is open, so idle is a hope rather than a promise. Waiting for it when
    // it comes and carrying on when it does not is the difference between a slow read and a run
    // that dies on one item of nine courses.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    return { item, objects: await harvestEveryFrame(page) };
  } catch (error) {
    return { item, objects: [], reason: error.message };
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

// Read off the DOM properties rather than the attributes: `src` as a property is the address the
// browser resolved and would fetch, and the attribute is the string an author wrote. The whole
// question `docs/adr/0007` leaves open is whether those two differ, so taking the attribute here
// would be measuring the body again through a browser.
function harvest(frame) {
  return frame.evaluate(
    ({ labelLimit, elementLimit }) => {
      /* global document */
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
      const ADDRESSES = ["currentSrc", "src", "href", "data"];
      const found = [];

      for (const element of document.querySelectorAll(Object.keys(KINDS).join(","))) {
        const url = ADDRESSES.map((name) => element[name]).find(
          (value) => typeof value === "string" && value,
        );
        if (!url) continue;
        const label =
          element.getAttribute("alt") || element.getAttribute("title") || element.textContent || "";
        found.push({
          url,
          kind: KINDS[element.tagName.toLowerCase()],
          label: label.replace(/\s+/g, " ").trim().slice(0, labelLimit),
          element: element.outerHTML.slice(0, elementLimit),
        });
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
  return `a[href*="/ultra/courses/${courseId}/outline/"]`;
}

function itemIdIn(url) {
  return url.match(/\/outline\/(?:[^/?#]+\/)*(_\d+_\d+)/)?.[1] ?? "";
}

function clean(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
