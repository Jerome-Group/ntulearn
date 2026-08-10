import TurndownService from "turndown";
import { courseUrl } from "../ntulearn/urls.mjs";

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
