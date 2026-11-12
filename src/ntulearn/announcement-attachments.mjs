import TurndownService from "turndown";
import { absoluteUrl, isNtulearnUrl } from "./urls.mjs";

export function announcementAttachments(course, announcement) {
  const courseId = course.displayId || course.courseId;
  if (typeof courseId !== "string" || typeof announcement.id !== "string") return [];
  const files = new Map();
  const html = `${announcement.body?.displayText ?? ""}\n${announcement.body?.rawText ?? ""}`;
  const links = [];
  const rememberLink = (node) => {
    if (node.nodeName === "A") links.push(node.getAttribute("href"));
  };
  const parser = new TurndownService({
    blankReplacement: (_text, node) => {
      rememberLink(node);
      return "";
    },
  });
  parser.addRule("announcementLinks", {
    filter: "a",
    replacement: (text, node) => {
      rememberLink(node);
      return text;
    },
  });
  parser.turndown(html);
  for (const href of links) {
    try {
      const url = new URL(absoluteUrl(href));
      if (!isNtulearnUrl(url.href) || url.username || url.password || url.search || url.hash)
        continue;
      const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
      if (
        parts.length !== 7 ||
        parts.slice(0, 3).join("/") !== "bbcswebdav/internal/courses" ||
        parts[3] !== courseId ||
        parts[4] !== "announcements" ||
        parts[5] !== announcement.id
      )
        continue;
      const fileName = parts[6];
      if (
        !/\.pdf$/i.test(fileName) ||
        /[/\\]/.test(fileName) ||
        [...fileName].some(
          (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
        )
      )
        continue;
      files.set(url.href, { resourceUrl: url.href, fileName, mimeType: "application/pdf" });
    } catch {}
  }
  return [...files.values()];
}
