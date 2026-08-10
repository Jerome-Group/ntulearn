import { absoluteUrl } from "./urls.mjs";

const FOLDER_HANDLER = "resource/x-bb-folder";
const FILE_HANDLER = "resource/x-bb-file";

export function isFolder(item) {
  return Boolean(
    item.contentDetail?.[FOLDER_HANDLER]?.isFolder || item.contentHandler === FOLDER_HANDLER,
  );
}

export function isFile(item) {
  return item.contentHandler === FILE_HANDLER;
}

export function attachmentsOf(item) {
  const files = [];
  const attached = item.contentDetail?.[FILE_HANDLER]?.file;
  if (attached?.permanentUrl) files.push({ ...attached, resourceUrl: attached.permanentUrl });

  const html = `${item.body?.rawText ?? ""}\n${item.body?.displayText ?? ""}`;
  for (const [, encoded] of html.matchAll(/data-bbfile="([^"]+)"/g)) {
    try {
      const embedded = JSON.parse(decodeHtmlEntities(encoded));
      if (embedded.resourceUrl) files.push(embedded);
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

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
