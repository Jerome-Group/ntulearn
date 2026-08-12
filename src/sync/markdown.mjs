import TurndownService from "turndown";
import { isSupplied, kindOf } from "../ntulearn/content.mjs";
import { courseUrl } from "../ntulearn/urls.mjs";

const EMBED_ATTRIBUTE = "data-bbfile";

const EVENT_HANDLER_ATTRIBUTE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL_ATTRIBUTE = /(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi;
// A line of spaces is a blank line here; Turndown emits them where the source HTML had a <br>.
const BLANK_LINE_RUN = /\n(?:[ \t]*\n){2,}/g;

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});
turndown.remove(["script", "style", "iframe", "object", "embed", "form"]);

// NTULearn leaves an embed's anchor without link text, and an embedded player's href unwritten,
// so the plain conversion gives `[](url)` for every attachment and `[undefined](undefined)` for
// every video. What the embed is stays in its `data-bbfile`, which carries the name and — for a
// player, whose file is a stream rather than a download — the URL to watch it at.
turndown.addRule("bbEmbed", {
  filter: (node) => node.nodeName === "A" && node.hasAttribute(EMBED_ATTRIBUTE),
  replacement: (text, node) => {
    const embed = embedOf(node);
    const target = firstSupplied(node.getAttribute("href"), embed.url);
    const label = firstSupplied(
      text,
      embed.linkName,
      embed.displayName,
      embed.fileName,
      embed.title,
    );
    if (!target) return label ?? "";
    return `[${label ?? target}](${target})`;
  },
});

export function htmlToMarkdown(value) {
  const html = String(value ?? "")
    .replace(EVENT_HANDLER_ATTRIBUTE, "")
    .replace(JAVASCRIPT_URL_ATTRIBUTE, 'href="#"');
  return turndown.turndown(html).replace(BLANK_LINE_RUN, "\n\n").trim();
}

export function courseDocument(course) {
  const description = htmlToMarkdown(course.description);
  return document(course.displayName, [
    [
      `- Course ID: ${course.displayId || course.courseId || course.id}`,
      `- Source: ${courseUrl(course.id)}`,
      `- Synced: ${new Date().toISOString()}`,
    ].join("\n"),
    description,
  ]);
}

// Empty when the item carries neither text nor a link, so the caller writes no file for it.
export function contentDocument(item, externalLink = null) {
  const description = htmlToMarkdown(item.description);
  const body = htmlToMarkdown(item.body?.displayText || item.body?.rawText);
  const sections = [
    description && `## Description\n\n${description}`,
    body && `## Content\n\n${body}`,
    externalLink && `## External link\n\n${externalLink}`,
  ];
  return sections.some(Boolean) ? document(item.title, sections) : "";
}

// A later run may correct one of these and must never touch a page, so a document says which it is
// in a mark that survives every rewording of what a reader sees. Comments render as nothing, which
// is the point: this is addressed to the next run rather than to the student.
const UNCOPIED_MARK = "<!-- ntulearn: nothing to copy -->";

// Everything written before that mark existed is recognised by its sentence instead. That is the
// weaker test — a rewording strands whatever the old words are still on disk — so it is here for
// the destinations that already exist and gains nothing by growing.
const UNCOPIED_STATEMENT =
  "This item carries no text, no link and no attachment, so there was nothing to copy. " +
  "Open it in NTULearn.";

// Written in place of the item itself, so nothing NTULearn returns leaves the destination without
// a trace of having existed and the numbering has no unexplained gap (ADR-0006).
export function uncopiedDocument(item, trail) {
  return document(item.title, [
    [`- Kind: ${kindOf(item)}`, trail && `- Trail: ${trail}`].filter(Boolean).join("\n"),
    UNCOPIED_STATEMENT,
    UNCOPIED_MARK,
  ]);
}

export function isUncopiedDocument(text) {
  if (typeof text !== "string") return false;
  return text.includes(UNCOPIED_MARK) || text.includes(UNCOPIED_STATEMENT);
}

export function announcementDocument(announcement) {
  const body = htmlToMarkdown(announcement.body?.displayText || announcement.body?.rawText);
  return document(announcement.title, [
    [
      `- Created: ${isoDate(announcement.createdDate) ?? "Unknown"}`,
      `- Modified: ${isoDate(announcement.modifiedDate) ?? "Unknown"}`,
    ].join("\n"),
    body,
  ]);
}

export function isoDate(value) {
  if (!value) return null;
  return typeof value === "number" ? new Date(value).toISOString() : value;
}

function document(title, sections) {
  return `# ${title}\n\n${sections.filter(Boolean).join("\n\n")}\n`;
}

function embedOf(node) {
  try {
    return JSON.parse(node.getAttribute(EMBED_ATTRIBUTE)) ?? {};
  } catch {
    // A malformed data-bbfile attribute names nothing, so the element's own link stands alone.
    return {};
  }
}

function firstSupplied(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (isSupplied(text)) return text;
  }
  return null;
}
