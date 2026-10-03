import { discoverContentRecordings } from "./discovery.mjs";
import { discoverMediaGallery, isMediaCourseEnabled } from "./gallery.mjs";
import { readKalturaMediaGallery } from "./gallery-browser.mjs";
import { assertCourseAnnouncementGuard } from "./course-announcement.mjs";
import { isGlobalMediaSafetyFailure } from "./errors.mjs";

export async function discoverCourseMedia({
  client,
  course,
  readGallery = readKalturaMediaGallery,
  adapters,
}) {
  if (!isMediaCourseEnabled(course)) {
    return discoverMediaGallery({ course, pages: null });
  }

  if (typeof client?.withBrowserPage !== "function")
    throw new Error("Media discovery needs the signed-in NTULearn client.");
  if (typeof readGallery !== "function")
    throw new Error("Media Gallery discovery needs a gallery reader.");
  return guardedBrowserPage(client, async (page) => {
    await assertCourseAnnouncementGuard(page);
    if (typeof client?.readCourse !== "function")
      throw new Error("Content recording discovery needs the signed-in NTULearn client.");
    const snapshot = await guardedMediaRead(page, () => client.readCourse(course.courseId));
    const contentRecordings = await discoverCourseContent({
      client,
      course,
      adapters,
      snapshot,
      page,
    });
    const gallery = await guardedMediaRead(page, () => readGallery({ page, course, snapshot }), {
      retainRed: true,
    });
    return combinedDiscovery(contentRecordings, gallery);
  });
}
function combinedDiscovery(contentRecordings, gallery) {
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
  snapshot,
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
  const discovery = await guardedBrowserPage(client, async (page) => {
    await assertCourseAnnouncementGuard(page);
    return guardedMediaRead(page, () => readGallery({ page, course, snapshot }), {
      retainRed: true,
    });
  });
  return discovery;
}

async function discoverCourseContent({ client, course, adapters, snapshot, page }) {
  const attachmentsByItem = new Map();
  if (typeof client.readAttachments === "function") {
    for (const item of snapshot.items ?? []) {
      attachmentsByItem.set(
        item.id,
        (await guardedMediaRead(page, () => client.readAttachments(course.courseId, item))) ?? [],
      );
    }
  }
  return discoverContentRecordings({ course, snapshot, attachmentsByItem, adapters });
}
async function guardedMediaRead(page, operation, { retainRed = false } = {}) {
  await assertCourseAnnouncementGuard(page);
  let result;
  try {
    result = await operation();
  } catch (error) {
    if (isGlobalMediaSafetyFailure(error)) throw error;
    await assertCourseAnnouncementGuard(page);
    throw error;
  }
  try {
    await assertCourseAnnouncementGuard(page);
  } catch (error) {
    // Keep positively read content authority beside the reader's already-red sticky Gallery result.
    if (retainRed && result?.complete === false && result.diagnostic?.code === error.code)
      return result;
    throw error;
  }
  return result;
}

async function guardedBrowserPage(client, read) {
  let page,
    callbackError,
    callbackSettled = false,
    result;
  try {
    result = await client.withBrowserPage(async (ownedPage) => {
      page = ownedPage;
      try {
        return await read(page);
      } catch (error) {
        callbackError = error;
        throw error;
      } finally {
        callbackSettled = true;
      }
    });
  } catch (error) {
    if (isGlobalMediaSafetyFailure(error)) throw error;
    if (callbackSettled && error !== callbackError)
      throw Object.assign(
        new Error("Owned media page cleanup could not be confirmed.", { cause: error }),
        { code: "MEDIA_BROWSER_CLEANUP", globalSafety: true },
      );
    if (page) await assertCourseAnnouncementGuard(page);
    throw error;
  }
  try {
    await assertCourseAnnouncementGuard(page);
  } catch (error) {
    if (result?.complete === false && result.diagnostic?.code === error.code) return result;
    throw error;
  }
  return result;
}
