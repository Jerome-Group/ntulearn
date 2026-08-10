import { chromium } from "playwright";
import { chmod, mkdir } from "node:fs/promises";

const BASE_URL = "https://ntulearn.ntu.edu.sg";

export async function openNtulearn(profilePath, { headless = true } = {}) {
  await mkdir(profilePath, { recursive: true });
  await chmod(profilePath, 0o700);
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
  });

  if (!headless) return new LoginSession(context);

  const page = context.pages()[0] ?? await context.newPage();
  let xsrf = "";
  page.on("request", (request) => {
    xsrf ||= request.headers()["x-blackboard-xsrf"] ?? "";
  });
  await page.goto(`${BASE_URL}/ultra/course`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  if (!page.url().startsWith(`${BASE_URL}/ultra/`)) {
    await context.close();
    throw new Error("NTULearn session expired. Run: npm run login");
  }
  if (!xsrf) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
  }
  if (!xsrf) {
    await context.close();
    throw new Error("Could not capture NTULearn XSRF session value. Run: npm run login");
  }

  return new NtulearnSession(context, xsrf);
}

class LoginSession {
  constructor(context) {
    this.context = context;
  }

  async page() {
    const page = this.context.pages()[0] ?? await this.context.newPage();
    await page.goto(`${BASE_URL}/ultra/course`, { waitUntil: "domcontentloaded" });
    return page;
  }

  close() {
    return this.context.close();
  }
}

class NtulearnSession {
  constructor(context, xsrf) {
    this.context = context;
    this.xsrf = xsrf;
  }

  close() {
    return this.context.close();
  }

  async discoverCourses() {
    const me = await this.getJson("/learn/api/v1/users/me");
    const memberships = await this.getJson(`/learn/api/v1/users/${me.id}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true&limit=10000`);
    return (memberships.results ?? [])
      .map((membership) => membership.course)
      .filter(Boolean)
      .map((course) => ({
        id: course.id,
        displayId: course.displayId,
        displayName: course.displayName,
        available: course.effectiveAvailability?.available ?? null,
        url: `${BASE_URL}/ultra/courses/${course.id}/outline`,
      }));
  }

  async readCourse(courseId) {
    const [course, announcements, conversations, content] = await Promise.all([
      this.getJson(`/learn/api/v1/courses/${courseId}`),
      this.getJson(`/learn/api/v1/courses/${courseId}/announcements?limit=1000&offset=0&sort=startDateRestriction(desc)`, true),
      this.getJson(`/learn/api/v1/courses/${courseId}/conversations?limit=1000&offset=0`, true),
      this.#crawl(courseId),
    ]);
    return {
      course,
      announcements: announcements.results ?? [],
      conversations: conversations.results ?? [],
      items: content.items,
      observations: content.observations,
    };
  }

  async download(resourceUrl) {
    const response = await this.context.request.get(new URL(resourceUrl, BASE_URL).href);
    if (!response.ok()) throw new Error(`Download failed: HTTP ${response.status()}`);
    return { buffer: await response.body(), headers: response.headers() };
  }

  async getJson(path, allow404 = false) {
    const response = await this.context.request.get(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json", "X-Blackboard-XSRF": this.xsrf },
    });
    if (allow404 && response.status() === 404) return { results: [], unavailable: true };
    if (response.status() === 401 || response.status() === 403) {
      throw new Error(`Authentication rejected for ${path}. Run: npm run login`);
    }
    if (!response.ok()) throw new Error(`NTULearn request failed for ${path}: HTTP ${response.status()}`);
    return response.json();
  }

  async #crawl(courseId) {
    const items = [];
    const seen = new Set();
    const pending = ["ROOT"];
    let requestCount = 0;
    let largestPage = 0;

    while (pending.length) {
      const parentId = pending.shift();
      let path = `/learn/api/v1/courses/${courseId}/contents/${parentId}/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=false&limit=1000&offset=0`;
      while (path) {
        const body = await this.getJson(path);
        requestCount += 1;
        largestPage = Math.max(largestPage, body.results?.length ?? 0);
        for (const item of body.results ?? []) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
          if (isFolder(item)) pending.push(item.id);
        }
        path = body.paging?.nextPage ?? "";
      }
    }
    return { items, observations: { requestCount, largestPage, requestedLimit: 1000 } };
  }
}

export function isFolder(item) {
  return Boolean(item.contentDetail?.["resource/x-bb-folder"]?.isFolder || item.contentHandler === "resource/x-bb-folder");
}

export function extractAttachments(item) {
  const files = [];
  const direct = item.contentDetail?.["resource/x-bb-file"]?.file;
  if (direct?.permanentUrl) files.push({ ...direct, resourceUrl: direct.permanentUrl });
  const html = `${item.body?.rawText ?? ""}\n${item.body?.displayText ?? ""}`;
  for (const match of html.matchAll(/data-bbfile="([^"]+)"/g)) {
    try {
      const value = JSON.parse(decodeHtml(match[1]));
      if (value.resourceUrl) files.push(value);
    } catch {}
  }
  return [...new Map(files.map((file) => [file.resourceUrl, file])).values()];
}

export function externalLink(item) {
  const detail = Object.values(item.contentDetail ?? {})[0] ?? {};
  return detail.url || detail.launchLink || detail.placement?.launchLink || null;
}

function decodeHtml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

export { BASE_URL };
