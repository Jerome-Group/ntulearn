import { absoluteUrl } from "../ntulearn/urls.mjs";
import { galleryFailure } from "./gallery-diagnostic.mjs";

const ENDPOINT = "/webapps/blackboard/execute/blti/launchPlacement";
const ORIGIN = new URL(absoluteUrl("/")).origin;
const WAYFINDING = /(?:media\s+gallery|lecture\s+recordings?)/i;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const QUERY = ["blti_placement_id", "content_id", "course_id", "wrapped"];
const refused = () => galleryFailure("GALLERY_LAUNCH_REFUSED");

// A title selects where to look. Only the supplied current link and identity claims grant navigation.
export function observedGalleryLaunch({ snapshot, course }) {
  if (snapshot === undefined) return null; // Existing standalone/legacy adapters have no snapshot.
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length > 20000) throw refused();
  const candidates = [];
  for (const item of snapshot.items) {
    if (typeof item?.title !== "string") continue;
    if (item.title.length > 4096) throw refused();
    if (WAYFINDING.test(item.title)) candidates.push(item);
  }
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw refused();
  const item = candidates[0];
  const details = item.contentDetail;
  if (details === undefined) return null;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw refused();
  const entries = Object.values(details);
  if (entries.length > 32) throw refused();
  const links = [];
  for (const detail of entries) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw refused();
    for (const [holder, field] of [
      [detail, "launchLink"],
      [detail.placement, "launchLink"],
    ]) {
      if (holder && Object.hasOwn(holder, field)) {
        if (links.length >= 64) throw refused();
        links.push({ value: holder[field], detail });
      }
    }
    if (detail.launchUrl !== undefined || detail.placement?.launchUrl !== undefined)
      throw refused();
  }
  if (!links.length) return null;
  if (
    !ID.test(course?.courseId ?? "") ||
    snapshot.course?.id !== course.courseId ||
    !ID.test(item.id ?? "")
  )
    throw refused();
  const normalized = new Map();
  for (const { value, detail } of links) {
    const url = qualifiedLink(value, course.courseId, item.id);
    for (const holder of [item, detail, detail.placement]) {
      if (holder?.courseId !== undefined && holder.courseId !== course.courseId) throw refused();
      if (holder?.contentId !== undefined && holder.contentId !== item.id) throw refused();
    }
    if (
      !detail.placement ||
      typeof detail.placement !== "object" ||
      Array.isArray(detail.placement) ||
      typeof detail.placement.id !== "string" ||
      detail.placement.id !== url.searchParams.get("blti_placement_id")
    )
      throw refused();
    const sorted = new URL(url);
    sorted.searchParams.sort();
    normalized.set(sorted.href, value);
  }
  if (normalized.size !== 1) throw refused();
  return { url: absoluteUrl(normalized.values().next().value) };
}

function qualifiedLink(value, courseId, contentId) {
  // eslint-disable-next-line no-control-regex -- URL controls must refuse before parsing/normalization
  if (typeof value !== "string" || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value))
    throw refused();
  const path = value.match(/^(?:https:\/\/[^/?#]+)?(\/[^?#]*)/i)?.[1];
  if (path !== ENDPOINT) throw refused();
  let url;
  try {
    url = new URL(absoluteUrl(value));
  } catch {
    throw refused();
  }
  if (
    url.origin !== ORIGIN ||
    url.pathname !== ENDPOINT ||
    url.username ||
    url.password ||
    url.hash
  )
    throw refused();
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== QUERY.length ||
    QUERY.some((key) => url.searchParams.getAll(key).length !== 1) ||
    keys.some((key) => !QUERY.includes(key))
  )
    throw refused();
  if (
    url.searchParams.get("course_id") !== courseId ||
    url.searchParams.get("content_id") !== contentId ||
    !ID.test(url.searchParams.get("blti_placement_id") ?? "") ||
    url.searchParams.get("wrapped") !== "true"
  )
    throw refused();
  return url;
}
