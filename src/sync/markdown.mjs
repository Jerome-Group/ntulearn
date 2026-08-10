import TurndownService from "turndown";
import { isSupplied } from "../ntulearn/content.mjs";
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
