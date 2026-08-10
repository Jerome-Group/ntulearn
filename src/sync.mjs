import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { BASE_URL, extractAttachments, externalLink, isFolder } from "./ntulearn.mjs";
import { htmlToMarkdown, usefulMarkdown } from "./markdown.mjs";
import { orderedName, safeResolve, safeSegment } from "./paths.mjs";

export async function syncConfiguredCourse({ client, config, state }) {
  const snapshot = await client.readCourse(config.courseId);
  const previous = state.courses[config.key] ?? { downloads: {}, contentIds: [], announcementIds: [], conversationIds: [] };
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const current = { downloads: {}, contentIds: snapshot.items.map((item) => item.id) };
  const stats = { downloaded: 0, skipped: 0, bytes: 0, markdown: 0, failures: [] };

  await mkdir(config.destination, { recursive: true });
  await writeMarkdown(safeResolve(config.destination, "Course.md"), courseMarkdown(snapshot.course));
  stats.markdown += 1;

  for (const item of snapshot.items) {
    const parts = ancestorFolders(item, byId);
    if (isFolder(item)) {
      const folder = safeResolve(config.destination, ...parts, orderedName(item.position, item.title));
      await mkdir(folder, { recursive: true });
      const text = usefulMarkdown(item);
      if (text) {
        await writeMarkdown(safeResolve(folder, "_NTULearn.md"), itemMarkdown(item, text));
        stats.markdown += 1;
      }
      continue;
    }

    const text = usefulMarkdown(item);
    const link = externalLink(item);
    if (text || link) {
      const target = safeResolve(config.destination, ...parts, `${orderedName(item.position, item.title)}.md`);
      await writeMarkdown(target, itemMarkdown(item, text, link));
      stats.markdown += 1;
    }

    let attachments = extractAttachments(item);
    if (item.contentHandler === "resource/x-bb-file" && attachments.length === 0) {
      const detailed = await client.getJson(`/learn/api/v1/courses/${config.courseId}/contents/${item.id}?expand=gradebookCategory`);
      attachments = extractAttachments(detailed);
    }

    for (const attachment of attachments) {
      const filename = attachment.fileName || attachment.linkName || attachment.displayName || `${item.title}.bin`;
      const target = safeResolve(config.destination, ...parts, orderedName(item.position, filename));
      const relativePath = relative(config.destination, target);
      const fingerprint = `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
      const prior = previous.downloads?.[attachment.resourceUrl];

      if (prior?.fingerprint === fingerprint && prior.relativePath === relativePath && await matchesExisting(target, attachment.fileSize)) {
        current.downloads[attachment.resourceUrl] = prior;
        stats.skipped += 1;
        continue;
      }

      try {
        const { buffer, headers } = await client.download(attachment.resourceUrl);
        await atomicWrite(target, buffer);
        const record = {
          fingerprint,
          relativePath,
          bytes: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          mimeType: attachment.mimeType || headers["content-type"] || null,
        };
        current.downloads[attachment.resourceUrl] = record;
        stats.downloaded += 1;
        stats.bytes += buffer.length;
      } catch (error) {
        stats.failures.push({ item: item.title, file: filename, error: error.message });
      }
    }
  }

  const announcementsDir = safeResolve(config.destination, "Announcements");
  if (snapshot.announcements.length) await mkdir(announcementsDir, { recursive: true });
  for (const announcement of snapshot.announcements) {
    const date = datePrefix(announcement.createdDate || announcement.modifiedDate);
    const target = safeResolve(announcementsDir, `${date} ${safeSegment(announcement.title)}.md`);
    await writeMarkdown(target, announcementMarkdown(announcement));
    stats.markdown += 1;
  }

  current.announcementIds = snapshot.announcements.map((item) => item.id);
  current.conversationIds = snapshot.conversations.map((item) => item.id);
  current.syncedAt = new Date().toISOString();
  current.courseId = config.courseId;
  current.destination = config.destination;

  const result = {
    key: config.key,
    course: snapshot.course.displayName,
    destination: config.destination,
    contentItems: snapshot.items.length,
    announcements: snapshot.announcements.length,
    conversations: snapshot.conversations.length,
    newContent: difference(current.contentIds, previous.contentIds).length,
    newAnnouncements: difference(current.announcementIds, previous.announcementIds).length,
    newConversations: difference(current.conversationIds, previous.conversationIds).length,
    observations: snapshot.observations,
    ...stats,
  };
  state.courses[config.key] = current;
  return result;
}

export async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return { version: 1, courses: {}, ...state };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, courses: {} };
    throw error;
  }
}

export async function writeState(path, state) {
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

function ancestorFolders(item, byId) {
  const folders = [];
  let parent = byId.get(item.parentId);
  while (parent) {
    if (isFolder(parent)) folders.unshift(orderedName(parent.position, parent.title));
    parent = byId.get(parent.parentId);
  }
  return folders;
}

function courseMarkdown(course) {
  const description = htmlToMarkdown(course.description);
  return `# ${course.displayName}\n\n- Course ID: ${course.displayId || course.courseId || course.id}\n- Source: ${BASE_URL}/ultra/courses/${course.id}/outline\n- Synced: ${new Date().toISOString()}${description ? `\n\n${description}` : ""}\n`;
}

function itemMarkdown(item, body, link) {
  return `# ${item.title}\n\n${body || ""}${link ? `${body ? "\n\n" : ""}## External link\n\n${new URL(link, BASE_URL).href}` : ""}\n`;
}

function announcementMarkdown(item) {
  const body = htmlToMarkdown(item.body?.displayText || item.body?.rawText);
  return `# ${item.title}\n\n- Created: ${normalizeDate(item.createdDate) || "Unknown"}\n- Modified: ${normalizeDate(item.modifiedDate) || "Unknown"}\n\n${body}\n`;
}

async function writeMarkdown(path, content) {
  let existing;
  try { existing = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== content) await atomicWrite(path, content);
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function matchesExisting(path, expectedBytes) {
  try {
    const info = await stat(path);
    return info.isFile() && (expectedBytes == null || info.size === expectedBytes);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function datePrefix(value) {
  const date = normalizeDate(value);
  return date ? date.slice(0, 10) : "undated";
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function difference(current, previous = []) {
  const old = new Set(previous);
  return current.filter((value) => !old.has(value));
}
