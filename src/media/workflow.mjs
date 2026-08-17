import { discoverContentRecordings } from "./discovery.mjs";
import { discoverMediaGallery, isMediaCourseEnabled } from "./gallery.mjs";
import { readKalturaMediaGallery } from "./gallery-browser.mjs";

export async function discoverCourseMedia({
  client,
  course,
  readGallery = readKalturaMediaGallery,
  adapters,
}) {
  if (!isMediaCourseEnabled(course)) {
    return discoverMediaGallery({ course, pages: null });
  }

  const contentRecordings = await discoverCourseContent({ client, course, adapters });
  const gallery = await discoverCourseMediaGallery({ client, course, readGallery });
  const galleryRecordings = gallery.complete === true ? gallery.recordings : [];
  const queue = [...contentRecordings, ...galleryRecordings];

  return {
    ...gallery,
    recordings: queue,
    queue,
    contentRecordings,
    galleryRecordings,
    contentCount: contentRecordings.length,
    galleryCount: galleryRecordings.length,
    discoveredCount: gallery.complete === true ? queue.length : (gallery.discoveredCount ?? 0),
  };
}

export async function discoverCourseMediaGallery({
  client,
  course,
  readGallery = readKalturaMediaGallery,
}) {
  if (!isMediaCourseEnabled(course)) {
    return discoverMediaGallery({ course, pages: null });
  }
  if (typeof client?.withBrowserPage !== "function") {
    throw new Error("Media Gallery discovery needs the signed-in NTULearn client.");
  }
  if (typeof readGallery !== "function") {
    throw new Error("Media Gallery discovery needs a gallery reader.");
  }
  const discovery = await client.withBrowserPage((page) => readGallery({ page, course }));
  return discovery;
}

async function discoverCourseContent({ client, course, adapters }) {
  if (typeof client?.readCourse !== "function") {
    throw new Error("Content recording discovery needs the signed-in NTULearn client.");
  }
  const snapshot = await client.readCourse(course.courseId);
  const attachmentsByItem = new Map();
  if (typeof client.readAttachments === "function") {
    for (const item of snapshot.items ?? []) {
      attachmentsByItem.set(item.id, (await client.readAttachments(course.courseId, item)) ?? []);
    }
  }
  return discoverContentRecordings({ course, snapshot, attachmentsByItem, adapters });
}
