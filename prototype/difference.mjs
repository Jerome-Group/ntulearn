const BASE_URL = "https://ntulearn.ntu.edu.sg";

// The three shapes an address a file is served from takes here: NTULearn's own file store, an
// upload's session address, and the `xid-` a stored file is identified by anywhere it appears.
const FILE_SHAPED = /\/bbcswebdav\/|\/sessions\/|xid-/i;

// What the page carries, held against what the walk expects, in both directions. Neither side is
// this file's to produce: the objects come off a rendered page and the attachments out of
// `expectedAttachments`, and all this does is say where they disagree.
export function differenceBetween({ objects, attachments }) {
  const expected = new Map(attachments.map((each) => [comparableUrl(each.url), each]));
  const carried = gather(objects);

  const onPage = { objects: [], navigation: [] };
  for (const each of carried.values())
    onPage[each.navigation ? "navigation" : "objects"].push(each);

  const unmatched = (each) => !expected.has(each.url);
  return {
    onPage: { objects: onPage.objects.length, navigation: onPage.navigation.length },
    inWalk: expected.size,
    onBothSides: [...carried.keys()].filter((url) => expected.has(url)).length,
    onlyOnThePage: {
      objects: onPage.objects.filter(unmatched),
      navigation: onPage.navigation.filter(unmatched),
    },
    onlyInTheWalk: [...expected].filter(([url]) => !carried.has(url)).map(([, each]) => each),
  };
}

// One address written twice on a page is one object. Which elements carried it is kept, because a
// file reached by both an `<img>` and an `<a>` and a file reached only by an `<iframe>` are
// different findings for #33 — the second is the family nothing downloads.
function gather(objects) {
  const byUrl = new Map();

  for (const object of objects) {
    const url = comparableUrl(object.url);
    const already = byUrl.get(url);
    if (!already) {
      byUrl.set(url, {
        url,
        address: object.url,
        kinds: [object.kind],
        offsite: !isNtulearnUrl(object.url),
        fileShaped: FILE_SHAPED.test(object.url),
        navigation: isNavigation(object),
        carriedBy: [carrier(object)],
      });
      continue;
    }
    if (!already.kinds.includes(object.kind)) already.kinds.push(object.kind);
    // An address is navigation only while nothing has embedded it: a file linked in a sentence and
    // shown in an `<img>` further down is an object, and the sentence does not make it less of one.
    already.navigation &&= isNavigation(object);
    already.carriedBy.push(carrier(object));
  }

  return byUrl;
}

// A link is a link — the Markdown keeps it, so a reader still has it and nothing is lost. Every
// other element embeds something the conversion removes, which is the population #33 is about, and
// so is an `<a>` into a file address whatever NTULearn wrote around it.
function isNavigation(object) {
  return object.kind === "link" && !FILE_SHAPED.test(object.url);
}

function carrier({ kind, label, element, frame, itemId, itemTitle, itemUrl }) {
  return { kind, label, element, frame, itemId, itemTitle, itemUrl };
}

// Both sides through one normalisation, because the two disagree about a query string on an
// NTULearn address — a page's own link carries display options a permanent URL does not — and a
// difference that is only a query string is a difference about display rather than about a file.
//
// Only there. Off NTULearn the query string is the identity: every video on a course is the same
// Panopto embed address with a different `id`, and dropping it makes a course's whole set of
// recordings read as one object.
export function comparableUrl(url) {
  try {
    const address = new URL(url, BASE_URL);
    if (address.origin !== BASE_URL) return address.href;
    return `${address.origin}${address.pathname}`;
  } catch {
    return url;
  }
}

function isNtulearnUrl(url) {
  try {
    return new URL(url, BASE_URL).origin === BASE_URL;
  } catch {
    return false;
  }
}
