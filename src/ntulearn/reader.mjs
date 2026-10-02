import { attachmentsOf, isFile, isFolder } from "./content.mjs";
import { readCollection } from "./collections.mjs";
import { courseUrl } from "./urls.mjs";

const PAGE_SIZE = 1000;
const ROOT_FOLDER = "ROOT";

export class NtulearnReader {
  #get;
  constructor(get) {
    this.#get = get;
  }

  async listCourses() {
    const me = await this.#get("/learn/api/v1/users/me");
    const memberships = await readCollection(
      this.#get.bind(this),
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
      readCollection(
        this.#get.bind(this),
        `/learn/api/v1/courses/${courseId}/announcements` +
          `?limit=${PAGE_SIZE}&offset=0&sort=startDateRestriction(desc)`,
        { optional: true },
      ),
      readCollection(
        this.#get.bind(this),
        `/learn/api/v1/courses/${courseId}/conversations?limit=${PAGE_SIZE}&offset=0`,
        {
          optional: true,
        },
      ),
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

  #readContentItem(courseId, itemId) {
    return this.#get(
      `/learn/api/v1/courses/${courseId}/contents/${itemId}?expand=gradebookCategory`,
    );
  }

  async #readContentTree(courseId) {
    const items = [];
    const seen = new Set();
    const unvisitedFolders = [ROOT_FOLDER];

    while (unvisitedFolders.length) {
      const parentId = unvisitedFolders.shift();
      const path =
        `/learn/api/v1/courses/${courseId}/contents/${parentId}/children` +
        `?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory` +
        `&includeInActivityTracking=false&limit=${PAGE_SIZE}&offset=0`;

      const page = await readCollection(this.#get.bind(this), path);
      for (const item of page.results) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        if (isFolder(item)) unvisitedFolders.push(item.id);
      }
    }

    return items;
  }
}
