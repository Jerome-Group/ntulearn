import TurndownService from "turndown";

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});
turndown.remove(["script", "style", "iframe", "object", "embed", "form"]);

export function htmlToMarkdown(value) {
  const html = String(value ?? "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, 'href="#"');
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

export function usefulMarkdown(item) {
  const description = htmlToMarkdown(item.description);
  const body = htmlToMarkdown(item.body?.displayText || item.body?.rawText);
  return [description && `## Description\n\n${description}`, body && `## Content\n\n${body}`]
    .filter(Boolean)
    .join("\n\n");
}
