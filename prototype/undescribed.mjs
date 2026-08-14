import { isNtulearnUrl } from "../src/ntulearn/urls.mjs";

// The count itself, apart from the session that feeds it, so it can be exercised against items
// written by hand. `count-undescribed.mjs` is the runner; this is what it runs.
const BASE_URL = "https://ntulearn.ntu.edu.sg";

const ELEMENT = /<(a|img)\b[^>]*>/gi;
// Both quote styles, where `src/ntulearn/content.mjs` reads only double. Deliberately wider than
// the walk: a measurement that shares the walk's blind spot cannot report on it.
const ELEMENT_LINK = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HAS_EMBED = /\bdata-bbfile\s*=/i;
const COURSE_FILE = /\/bbcswebdav\//i;
// The file id inside a `/bbcswebdav/` address. Two addresses for one file agree here and disagree
// on the `pid-` segment around it, which is why an exact match is not the only match that counts.
const FILE_ID = /xid-[A-Za-z0-9_]+/i;

export async function countCourse({ client, courseId, snapshot }) {
  const addresses = {
    ownAttachment: 0,
    ownAttachmentOtherAddress: 0,
    undescribed: 0,
    undescribedByElement: { a: 0, img: 0 },
    onUnwrittenSurfaceOnly: 0,
    describedByEmbed: 0,
    otherNtulearnLinks: 0,
    externalLinks: 0,
  };
  const bodies = { withHtml: 0, withCandidate: 0, withUndescribed: 0 };
  const undescribed = [];

  for (const item of snapshot.items) {
    const surfaces = surfacesOf(item);
    if (!surfaces.length) continue;
    bodies.withHtml += 1;

    const attached = await attachedTo(client, courseId, item);
    let candidateHere = false;
    let undescribedHere = false;

    for (const surface of surfaces) {
      for (const { element, address, describes } of elementsIn(surface.html)) {
        if (!address) continue;
        if (describes) {
          addresses.describedByEmbed += 1;
          continue;
        }
        if (!COURSE_FILE.test(address)) {
          // The two shapes the note must never reach, counted so the claim is measured rather than
          // asserted: a link out of NTULearn, and a link to another page of the course.
          if (isNtulearnUrl(address)) addresses.otherNtulearnLinks += 1;
          else addresses.externalLinks += 1;
          continue;
        }

        candidateHere = true;
        const verdict = classify(address, attached);
        addresses[verdict] += 1;
        if (verdict !== "undescribed") continue;

        undescribedHere = true;
        if (!surface.written) addresses.onUnwrittenSurfaceOnly += 1;
        addresses.undescribedByElement[element] += 1;
        undescribed.push({
          item: item.title,
          itemId: item.id,
          handler: item.contentHandler,
          surface: surface.name,
          element,
          address,
        });
      }
    }

    if (candidateHere) bodies.withCandidate += 1;
    if (undescribedHere) bodies.withUndescribed += 1;
  }

  return { items: snapshot.items.length, bodies, addresses, undescribed };
}

// Every surface the conversion writes, named, because a note lands only where the conversion goes.
// `contentDocument` writes the description and then `displayText || rawText` — so the other body
// surface is counted apart rather than folded in: an address only there is one no note would reach,
// even though `attachmentsOf` reads it.
export function surfacesOf(item) {
  const displayed = item.body?.displayText || item.body?.rawText || "";
  const other = item.body?.displayText ? (item.body?.rawText ?? "") : "";
  return [
    { name: "description", html: item.description ?? "", written: true },
    { name: "body", html: displayed, written: true },
    { name: "body(unwritten)", html: other, written: false },
  ].filter((surface) => surface.html);
}

export function* elementsIn(html) {
  for (const [element, name] of html.matchAll(ELEMENT)) {
    const link = element.match(ELEMENT_LINK);
    const address = decodeHtmlEntities(link?.[1] ?? link?.[2] ?? "");
    yield { element: name.toLowerCase(), address, describes: HAS_EMBED.test(element) };
  }
}

// What the sync has in hand for this item — asked of the client exactly as `expectedFiles` asks it,
// so a file item whose Summary omitted its attachment is re-read here too. Anything in this set is
// an address the sync downloads, and a note beside it would be the false sentence `docs/adr/0006`
// refuses.
export async function attachedTo(client, courseId, item) {
  const attachments = await client.readAttachments(courseId, item);
  const addresses = new Set();
  const fileIds = new Set();
  for (const attachment of attachments) {
    addresses.add(comparable(attachment.resourceUrl));
    const id = attachment.resourceUrl?.match(FILE_ID)?.[0];
    if (id) fileIds.add(id.toLowerCase());
  }
  return { addresses, fileIds };
}

export function classify(address, attached) {
  if (attached.addresses.has(comparable(address))) return "ownAttachment";
  const id = address.match(FILE_ID)?.[0];
  if (id && attached.fileIds.has(id.toLowerCase())) return "ownAttachmentOtherAddress";
  return "undescribed";
}

// Origin and path only, for the reason `prototype/compare.mjs` gives: the walk keeps a query string
// on an element's own link and drops it on a viewer URL, and a difference that is only a query
// string is about display options rather than about which file it is.
function comparable(url) {
  try {
    const { origin, pathname } = new URL(url ?? "", BASE_URL);
    return `${origin}${pathname}`;
  } catch {
    return String(url ?? "");
  }
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
