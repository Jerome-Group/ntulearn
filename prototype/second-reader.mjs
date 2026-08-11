import { openSignedInContext } from "../src/ntulearn/session.mjs";

// A second opinion on what a course holds, sharing no code with `src/ntulearn/content.mjs` and
// deliberately dumber than it (#29). The walk knows which items can contain children and which
// fields can carry a file; this knows neither, so it asks every item for children and greps every
// string of every item for anything file-shaped. Being wrong in the other direction is the point:
// what this over-reports is readable in one sitting, and what the walk under-reports is invisible.
//
// The session is shared with the walk because a blind transport is not the failure mode in
// question — nothing else here is. Even the address is written out rather than imported.
const BASE_URL = "https://ntulearn.ntu.edu.sg";
const ROOT_FOLDER = "ROOT";
const PAGE_SIZE = 1000;
const AT_A_TIME = 8;
const DECODE_PASSES = 3;

// Absolute or root-relative, stopped by whatever ends a link in HTML or in JSON. The lookbehind is
// what keeps `application/pdf` from reading as a path to `/pdf`.
const LINK = /(?<![\w.])(?:https?:\/\/[^\s"'<>\\)]+|\/[^\s"'<>\\)]+)/g;
const FILE_SHAPED = /\/bbcswebdav\/|xid-/i;
const ELEMENT_LINK = /\b(?:href|src)\s*=\s*"([^"]*)"/gi;
const EMBED = /\bdata-bbfile\s*=\s*"([^"]*)"/gi;

export async function openSecondReader(profilePath) {
  const { context, token } = await openSignedInContext(profilePath);
  const get = reading(context, token);
  return {
    read: (courseId) => readCourse(get, courseId),
    close: () => context.close(),
  };
}

async function readCourse(get, courseId) {
  const items = await everyItem(get, courseId);
  const links = new Map();
  const unreadable = [];

  await inBatches(items, async (item) => {
    const full = await get(`/learn/api/v1/courses/${courseId}/contents/${item.id}`);
    if (!full) {
      unreadable.push({ id: item.id, title: item.title ?? null });
      return;
    }
    for (const text of stringsIn(full)) {
      for (const link of linksIn(text)) {
        if (links.has(link)) continue;
        links.set(link, { link, itemId: item.id, itemTitle: full.title ?? item.title ?? null });
      }
    }
  });

  return { items: items.length, links: [...links.values()], unreadable };
}

// Every item is asked for children, not only the ones something has decided are containers: a
// container nothing recognises is the shape #17 had, and recognising it is what the walk does and
// this does not. A leaf answers with nothing, which costs a request and rules out a whole family.
async function everyItem(get, courseId) {
  const found = new Map();
  let frontier = [ROOT_FOLDER];

  while (frontier.length) {
    const next = [];
    await inBatches(frontier, async (parentId) => {
      for (const child of await children(get, courseId, parentId)) {
        if (found.has(child.id)) continue;
        found.set(child.id, child);
        next.push(child.id);
      }
    });
    frontier = next;
  }

  return [...found.values()];
}

// No `@view=Summary`, unlike the client's own walk: the Summary view is what omits an attached
// file, and asking for the full one costs a bigger response and no second request.
async function children(get, courseId, parentId) {
  const results = [];
  let path = `/learn/api/v1/courses/${courseId}/contents/${parentId}/children?limit=${PAGE_SIZE}&offset=0`;

  while (path) {
    const page = await get(path);
    if (!page) break;
    results.push(...(page.results ?? []));
    path = page.paging?.nextPage ?? "";
  }

  return results;
}

// The three things a file leaves behind, over every string in the item rather than over the body
// alone: a link that is file-shaped wherever it sits, an element's own link back to NTULearn, and
// whatever a `data-bbfile` carries inside it.
function linksIn(text) {
  const found = [];
  const decoded = decodeHtmlEntities(text);

  for (const [link] of decoded.matchAll(LINK)) {
    if (FILE_SHAPED.test(link)) found.push(link);
  }
  for (const [, link] of text.matchAll(ELEMENT_LINK)) {
    found.push(decodeHtmlEntities(link));
  }
  for (const [, embedded] of text.matchAll(EMBED)) {
    for (const [link] of decodeHtmlEntities(embedded).matchAll(LINK)) found.push(link);
  }

  return found.filter(isNtulearnUrl);
}

function* stringsIn(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const each of value) yield* stringsIn(each);
  else if (value && typeof value === "object")
    for (const each of Object.values(value)) yield* stringsIn(each);
}

function isNtulearnUrl(link) {
  try {
    return new URL(link, BASE_URL).origin === BASE_URL;
  } catch {
    return false;
  }
}

function reading(context, token) {
  return async (path) => {
    const response = await context.request.get(new URL(path, BASE_URL).href, {
      headers: { Accept: "application/json", "X-Blackboard-XSRF": token },
    });
    // A leaf has no children to answer with and an item can be forbidden. Either way there is
    // nothing to read, and a throwaway that dies on one item of six courses has spent a live
    // session to say so.
    return response.ok() ? response.json() : null;
  };
}

// Until it stops changing rather than once, because an embed's attribute is sometimes encoded
// twice and one pass leaves `&quot;` in the middle of the URL it was delimiting.
function decodeHtmlEntities(value) {
  let decoded = value;
  for (let pass = 0; pass < DECODE_PASSES; pass += 1) {
    const once = decoded
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    if (once === decoded) return decoded;
    decoded = once;
  }
  return decoded;
}

async function inBatches(items, run) {
  for (let start = 0; start < items.length; start += AT_A_TIME) {
    await Promise.all(items.slice(start, start + AT_A_TIME).map(run));
  }
}
