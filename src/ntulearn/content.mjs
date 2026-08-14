import { absoluteUrl, isNtulearnUrl } from "./urls.mjs";

const FOLDER_HANDLER = "resource/x-bb-folder";
const FILE_HANDLER = "resource/x-bb-file";
const KIND_NAMES = {
  "resource/x-bb-asmt-test-link": "Test",
  "resource/x-bb-assignment": "Assignment",
  "resource/x-plugin-scormengine": "SCORM package",
};
const EMBED = /<(?:a|img)\b[^>]*\bdata-bbfile="([^"]+)"[^>]*>/g;
const FILE_ID = /xid-[A-Za-z0-9_]+/i;
const ELEMENT_LINK = /\b(?:href|src)="([^"]+)"/;

// A folder is not the only container: a Learning Module holds children too, under its own handler
// key. Both say so the same way, with `isFolder` on whichever detail they carry, so that is what
// this reads — keying on the folder handler alone leaves a Learning Module's children unwalked.
export function isFolder(item) {
  if (item.contentHandler === FOLDER_HANDLER) return true;
  return Object.values(item.contentDetail ?? {}).some((detail) => detail?.isFolder === true);
}

export function isFile(item) {
  return item.contentHandler === FILE_HANDLER;
}

// The handler is what an item is, and it is legible enough to pass on unless a student would have
// to decode it. Only the ones that have needed translating are translated, and the table is never
// finished: a Building Block registers its own handler key, so the set is whatever an institution
// installed rather than anything a vendor list could close
// (`docs/research/does-blackboard-document-the-content-handlers.md`).
export function kindOf(item) {
  return KIND_NAMES[item.contentHandler] ?? item.contentHandler ?? "Unknown";
}

export function attachmentsOf(item) {
  const files = [];
  const attached = item.contentDetail?.[FILE_HANDLER]?.file;
  if (attached?.permanentUrl) files.push({ ...attached, resourceUrl: attached.permanentUrl });

  const html = `${item.body?.rawText ?? ""}\n${item.body?.displayText ?? ""}`;
  for (const [element, encoded] of html.matchAll(EMBED)) {
    try {
      const embedded = JSON.parse(decodeHtmlEntities(encoded));
      const resourceUrl = embeddedUrl(embedded, element);
      if (resourceUrl) files.push({ ...embedded, resourceUrl });
    } catch {
      // A malformed data-bbfile attribute describes no attachment, so there is nothing to add.
    }
  }

  return [...new Map(files.map((file) => [file.resourceUrl, file])).values()];
}

// Whether an address written in a body is a file the item already carries — the same file, whether
// or not it wears the same address. Two addresses for one file agree on the `xid-` and disagree on
// the `pid-` around it, so an exact match is not the only match that counts.
//
// Takes the attachments rather than the item, because the set that matters is the one the caller
// will actually download: `readAttachments` re-reads a file item whose Summary omitted its file,
// and `attachmentsOf(item)` alone would miss it.
//
// **Nothing calls this, deliberately.** #78 measured its population — a `/bbcswebdav/` address in a
// body that no `data-bbfile` describes — at zero across thirteen courses, and `docs/adr/0011`
// records the decision not to write a note about a population that does not exist. What is kept is
// the reasoning, tested: #77's rule would have told a student a file was missing while the sync was
// downloading it, and this is the answer to that, sitting where the item is rather than where only
// the HTML is. If the count moves off zero, the note is built on this rather than on a fresh guess.
export function isAttachedFile(attachments, address) {
  if (!isSupplied(address)) return false;
  const wanted = comparableUrl(address);
  const fileId = fileIdOf(address);
  // Two addresses neither of which resolves are not thereby the same address.
  if (wanted === null && fileId === null) return false;
  return attachments.some(
    (attachment) =>
      (wanted !== null && comparableUrl(attachment?.resourceUrl) === wanted) ||
      (fileId !== null && fileIdOf(attachment?.resourceUrl) === fileId),
  );
}

export function attachmentName(item, attachment) {
  return (
    attachment.fileName || attachment.linkName || attachment.displayName || `${item.title}.bin`
  );
}

// NTULearn has four names for the same thing, and which one an item uses is its handler's business
// rather than anything the item declares — a SCORM package says `launchUrl` where an LTI placement
// says `launchLink`. A name missing from this list is not a link that does not exist; it is a link
// this repository throws away, which is what ML0004's seven SCORM topics were (#53).
export function externalLinkOf(item) {
  const detail = Object.values(item.contentDetail ?? {})[0] ?? {};
  const link = detail.url || detail.launchUrl || detail.launchLink || detail.placement?.launchLink;
  return link ? absoluteUrl(link) : null;
}

// The element's own link is the live one. `resourceUrl` inside `data-bbfile` is a snapshot taken
// when the embed was written, and NTULearn does not revisit it: replace the file, or copy the
// course into a new term, and the link moves while the snapshot keeps pointing at a resource id
// that is gone. Sometimes the snapshot was never durable at all — a `/sessions/<id>/…` upload URL
// belongs to the authoring session that made it. So the element is asked first and the snapshot
// is the last resort, with the viewer link between them; its query string is display options
// rather than identity, and it resolves to the same bytes.
//
// The element's link counts only when it points back at NTULearn, because an ordinary outbound
// link in a body carries `data-bbfile` too, and it is a link rather than an attachment.
function embeddedUrl(embedded, element) {
  const link = element.match(ELEMENT_LINK)?.[1];
  const url = link && decodeHtmlEntities(link);
  if (isSupplied(url) && isNtulearnUrl(url)) return url;

  if (isSupplied(embedded.viewerUrl)) return embedded.viewerUrl.split("?")[0];
  return isSupplied(embedded.resourceUrl) ? embedded.resourceUrl : null;
}

// Where NTULearn has no value it writes the *word* — `undefined` in an embedded player's URL and
// in its link text both — rather than leaving the field out. Every such word is truthy, so each
// one is a value that reads as supplied until it is asked for: a URL that resolves against the
// origin and downloads the error page, or a link labelled `undefined` in the Markdown.
export function isSupplied(value) {
  return typeof value === "string" && value !== "" && value !== "undefined" && value !== "null";
}

// Origin and path only: NTULearn writes the same file with a query string on one surface and
// without it on another, and a difference that is only a query string is about display options
// rather than about which file it is.
function comparableUrl(pathOrUrl) {
  try {
    const { origin, pathname } = new URL(absoluteUrl(pathOrUrl));
    return `${origin}${pathname}`;
  } catch {
    return null;
  }
}

// The file id inside a `/bbcswebdav/` address, lower-cased so two spellings of one id are one id.
function fileIdOf(pathOrUrl) {
  return typeof pathOrUrl === "string"
    ? (pathOrUrl.match(FILE_ID)?.[0]?.toLowerCase() ?? null)
    : null;
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
