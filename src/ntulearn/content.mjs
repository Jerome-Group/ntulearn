import { absoluteUrl, isNtulearnUrl } from "./urls.mjs";

const FOLDER_HANDLER = "resource/x-bb-folder";
const FILE_HANDLER = "resource/x-bb-file";
const KIND_NAMES = {
  "resource/x-bb-asmt-test-link": "Test",
  "resource/x-bb-assignment": "Assignment",
};
const EMBED = /<(?:a|img)\b[^>]*\bdata-bbfile="([^"]+)"[^>]*>/g;
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
// to decode it. Only the ones that have needed translating are translated.
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

export function attachmentName(item, attachment) {
  return (
    attachment.fileName || attachment.linkName || attachment.displayName || `${item.title}.bin`
  );
}

export function externalLinkOf(item) {
  const detail = Object.values(item.contentDetail ?? {})[0] ?? {};
  const link = detail.url || detail.launchLink || detail.placement?.launchLink;
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

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
