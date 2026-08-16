import { discoverMediaGallery, isMediaCourseEnabled } from "./gallery.mjs";
import { readKalturaMediaGallery } from "./gallery-browser.mjs";

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
