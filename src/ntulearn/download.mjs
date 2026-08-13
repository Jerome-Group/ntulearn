import { isSupplied } from "./content.mjs";
import { absoluteUrl, isSignInUrl } from "./urls.mjs";

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];

// A download that arrives `200` has not thereby arrived: a session that expires between reading
// the course and fetching the file redirects to a sign-in page, which answers `200` with HTML, and
// NTULearn renders its own error pages at `200` too. Saved, either becomes the wrong bytes under
// the right name, recorded as correct and counted as present by `verify`, which checks presence
// rather than content (ADR-0005). This says which responses are not the file, so the client can
// refuse them into the failure path that already works.
//
// Only structural evidence counts — what arrived against what the attachment claims to be. The
// obvious extra signal, NTULearn's `fileSize`, is deliberately unread: ADR-0005 records it as
// absent or wrong often enough that checking it would report gaps that are not there.
export function downloadRefusal({ attachment, url, contentType }) {
  const name = attachmentClaim(attachment).name || "a file";

  if (isSignInUrl(url)) {
    return `Not signed in while downloading ${name}: the download was answered by the sign-in page at ${addressOf(url)}. Run: npm run login`;
  }

  if (isHtml(contentType) && !isWebPage(attachment)) {
    return `NTULearn answered the download of ${name} with a web page (${contentType}) rather than the file. Open the item in NTULearn to see whether the file is still there.`;
  }

  return null;
}

// What arrived, verbatim, because a record of a run holds what the run saw and NTULearn's claim is
// evidence of nothing but itself. The claim is kept beside it only where the two disagree, which is
// the one moment either is worth reading: the refusal above is narrow by design, so a response that
// is neither the file nor a web page arrives, and this is what says so (#60). Parameters are how a
// type was sent rather than what it is, so they are no disagreement.
export function downloadedType(attachment, headers) {
  const arrived = headers["content-type"] || null;
  const { type } = attachmentClaim(attachment);
  const claimed = isSupplied(type) ? type : null;
  const disagrees = claimed !== null && mediaType(claimed) !== mediaType(arrived);
  return { mimeType: arrived, ...(disagrees ? { claimedMimeType: claimed } : {}) };
}

// Four fields for one name and one type, because which pair an attachment uses is its kind's
// business: a file attached to an item states a `fileName`, an embed in a body a `linkName`.
function attachmentClaim(attachment) {
  return {
    name: attachment.fileName || attachment.linkName || attachment.displayName || "",
    type: attachment.mimeType,
  };
}

function isWebPage(attachment) {
  const { name, type } = attachmentClaim(attachment);
  return isHtml(type) || HTML_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function isHtml(contentType) {
  return HTML_TYPES.has(mediaType(contentType));
}

// The type without its parameters, which are how it was sent rather than what it is: a `charset`
// is not a different file from the same type without one.
function mediaType(contentType) {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

// Without the query string, which on the way back from an identity provider is the entire request
// that was interrupted and says nothing a reader needs.
function addressOf(url) {
  const { origin, pathname } = new URL(absoluteUrl(url));
  return `${origin}${pathname}`;
}
