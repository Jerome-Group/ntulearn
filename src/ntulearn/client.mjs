import { attachmentsOf, isFile, isFolder } from "./content.mjs";
import { downloadRefusal } from "./download.mjs";
import { optionalIsMissing, readRefusal } from "./read.mjs";
import { openSignedInContext } from "./session.mjs";
import { absoluteUrl, courseUrl } from "./urls.mjs";

const PAGE_SIZE = 1000;
const ROOT_FOLDER = "ROOT";

export async function openClient(profilePath) {
  const { context, token } = await openSignedInContext(profilePath);
  return new NtulearnClient(context, token);
}

// Everything this repository reads out of NTULearn, as the student who is signed in can see it.
class NtulearnClient {
  #context;
  #token;

  constructor(context, token) {
    this.#context = context;
    this.#token = token;
  }

  close() {
    return this.#context.close();
  }

  async listCourses() {
    const me = await this.#get("/learn/api/v1/users/me");
    const memberships = await this.#get(
      `/learn/api/v1/users/${me.id}/memberships` +
        `?expand=course.effectiveAvailability,course.permissions,courseRole` +
        `&includeCount=true&limit=${PAGE_SIZE * 10}`,
    );
    return (memberships.results ?? [])
      .map((membership) => membership.course)
      .filter(Boolean)
      .map((course) => ({
        id: course.id,
        displayId: course.displayId,
        displayName: course.displayName,
        available: course.effectiveAvailability?.available ?? null,
        url: courseUrl(course.id),
      }));
  }

  async readCourse(courseId) {
    const [course, announcements, conversations, items] = await Promise.all([
      this.#get(`/learn/api/v1/courses/${courseId}`),
      this.#get(
        `/learn/api/v1/courses/${courseId}/announcements` +
          `?limit=${PAGE_SIZE}&offset=0&sort=startDateRestriction(desc)`,
        { optional: true },
      ),
      this.#get(`/learn/api/v1/courses/${courseId}/conversations?limit=${PAGE_SIZE}&offset=0`, {
        optional: true,
      }),
      this.#readContentTree(courseId),
    ]);
    return {
      course,
      announcements: announcements.results ?? [],
      conversations: conversations.results ?? [],
      // Which optional reads yielded nothing because nothing could be read, rather than because
      // there is nothing there. The two are the same empty list and they are not the same fact.
      unavailable: {
        announcements: announcements.unavailable === true,
        conversations: conversations.unavailable === true,
      },
      items,
    };
  }

  // The Summary view omits an attached file, so an item known to have one is re-read in full.
  async readAttachments(courseId, item) {
    const attachments = attachmentsOf(item);
    if (attachments.length || !isFile(item)) return attachments;
    return attachmentsOf(await this.#readContentItem(courseId, item.id));
  }

  async download(attachment) {
    const response = await this.#context.request.get(absoluteUrl(attachment.resourceUrl));
    if (!response.ok()) throw new Error(`Download failed: HTTP ${response.status()}`);
    const headers = response.headers();
    const refusal = downloadRefusal({
      attachment,
      url: response.url(),
      contentType: headers["content-type"],
    });
    if (refusal) throw new Error(refusal);
    return { body: await response.body(), headers };
  }

  #readContentItem(courseId, itemId) {
    return this.#get(
      `/learn/api/v1/courses/${courseId}/contents/${itemId}?expand=gradebookCategory`,
    );
  }

  async #get(path, { optional = false } = {}) {
    const response = await this.#context.request.get(absoluteUrl(path), {
      headers: { Accept: "application/json", "X-Blackboard-XSRF": this.#token },
    });
    const status = response.status();
    if (optional && optionalIsMissing(status)) return { results: [], unavailable: true };
    const refusal = readRefusal({ status, path });
    if (refusal) throw refusal;
    return response.json();
  }

  async #readContentTree(courseId) {
    const items = [];
    const seen = new Set();
    const unvisitedFolders = [ROOT_FOLDER];

    while (unvisitedFolders.length) {
      const parentId = unvisitedFolders.shift();
      let path =
        `/learn/api/v1/courses/${courseId}/contents/${parentId}/children` +
        `?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory` +
        `&includeInActivityTracking=false&limit=${PAGE_SIZE}&offset=0`;

      while (path) {
        const page = await this.#get(path);
        for (const item of page.results ?? []) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
          if (isFolder(item)) unvisitedFolders.push(item.id);
        }
        path = page.paging?.nextPage ?? "";
      }
    }

    return items;
  }
}
