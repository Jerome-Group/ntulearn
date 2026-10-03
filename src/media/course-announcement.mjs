import { setTimeout, clearTimeout } from "node:timers";
import { isNtulearnUrl } from "../ntulearn/urls.mjs";
import { galleryFailure, GALLERY_WAIT_LIMITS } from "./gallery-diagnostic.mjs";

const MODALS =
  '[role="dialog"]:visible, [role="alertdialog"]:visible, dialog:visible, [aria-modal="true"]:visible';
const guards = new WeakMap();

export async function closeCourseAnnouncement(page) {
  await assertCourseAnnouncementGuard(page);
  if (typeof page?.locator !== "function") return false;
  const modals = page.locator(MODALS);
  // Legacy offline adapters may not model dialogs. They cannot authorize dismissal.
  if (typeof modals?.count !== "function" || typeof modals.nth !== "function") return false;
  let state;
  try {
    const count = await bounded(() => modals.count());
    if (count === 0) return false;
    if (count !== 1) throw galleryFailure("GALLERY_NOTICE_UNRECOGNIZED");
    const modal = modals.nth(0);
    if (typeof modal?.getByRole !== "function") throw galleryFailure("GALLERY_NOTICE_UNRECOGNIZED");
    const heading = modal.getByRole("heading", { name: "New Course Announcement", exact: true });
    const close = modal.getByRole("button", { name: "Close new announcements modal", exact: true });
    if (
      (await bounded(() => heading.count())) !== 1 ||
      (await bounded(() => close.count())) !== 1 ||
      typeof close.click !== "function" ||
      typeof modal.waitFor !== "function"
    )
      throw galleryFailure("GALLERY_NOTICE_UNRECOGNIZED");
    state = await ensureGuard(page);
    await checkGuard(state);
    // Recheck recognition after guard registration; never click a changed or multiple modal.
    if (
      (await bounded(() => modals.count())) !== 1 ||
      (await bounded(() => heading.count())) !== 1 ||
      (await bounded(() => close.count())) !== 1
    )
      throw galleryFailure("GALLERY_NOTICE_UNRECOGNIZED");
    try {
      await bounded(
        () => close.click({ timeout: GALLERY_WAIT_LIMITS.clickTimeoutMs }),
        "GALLERY_NOTICE_CLOSE_FAILED",
      );
    } catch {
      throw galleryFailure("GALLERY_NOTICE_CLOSE_FAILED");
    }
    await checkGuard(state);
    try {
      await bounded(
        () => modal.waitFor({ state: "hidden", timeout: GALLERY_WAIT_LIMITS.updateTimeoutMs }),
        "GALLERY_NOTICE_CLOSE_UNCONFIRMED",
      );
    } catch {
      throw galleryFailure("GALLERY_NOTICE_CLOSE_UNCONFIRMED");
    }
    if ((await bounded(() => modals.count())) !== 0)
      throw galleryFailure("GALLERY_NOTICE_CLOSE_UNCONFIRMED");
    await checkGuard(state);
    return true;
  } catch (error) {
    const failure = galleryFailure(error?.code ?? "GALLERY_NOTICE_UNRECOGNIZED");
    if (state) state.failure ??= failure.code;
    throw failure;
  }
}

export async function assertCourseAnnouncementGuard(page) {
  if (typeof page?.context !== "function") return;
  await checkGuard(await ensureGuard(page));
}

async function ensureGuard(page) {
  let context;
  try {
    context = page.context?.();
  } catch {
    throw galleryFailure("GALLERY_NOTICE_READ_GUARD_FAILED");
  }
  if (
    !context ||
    typeof context.route !== "function" ||
    typeof context.serviceWorkers !== "function"
  )
    throw galleryFailure("GALLERY_NOTICE_READ_GUARD_FAILED");
  if (guards.has(context)) {
    const state = guards.get(context);
    await state.installing;
    return state;
  }
  const state = { context, failure: null, pending: new Set() };
  guards.set(context, state);
  state.installing = (async () => {
    serviceWorkersAbsent(state);
    await bounded(
      () =>
        context.route("**/*", (route, request) => {
          const operation = routeRead(state, route, request);
          state.pending.add(operation);
          operation.finally(() => state.pending.delete(operation));
          return operation;
        }),
      "GALLERY_NOTICE_READ_GUARD_FAILED",
    );
    serviceWorkersAbsent(state);
  })().catch(() => {
    state.failure ??= "GALLERY_NOTICE_READ_GUARD_FAILED";
    throw galleryFailure(state.failure);
  });
  await state.installing;
  return state;
}

function serviceWorkersAbsent(state) {
  try {
    const workers = state.context.serviceWorkers();
    if (!Array.isArray(workers)) throw new Error("Absence unconfirmed");
    if (workers.length) {
      state.failure = "GALLERY_NOTICE_SERVICE_WORKER";
      throw new Error("Worker present");
    }
  } catch {
    state.failure ??= "GALLERY_NOTICE_READ_GUARD_FAILED";
    throw galleryFailure(state.failure);
  }
}
async function checkGuard(state) {
  try {
    await state.installing;
    serviceWorkersAbsent(state);
    if (state.failure) throw galleryFailure(state.failure);
    await bounded(() => Promise.all([...state.pending]), "GALLERY_NOTICE_READ_GUARD_FAILED");
    if (state.failure) throw galleryFailure(state.failure);
  } catch {
    state.failure ??= "GALLERY_NOTICE_READ_GUARD_FAILED";
    throw galleryFailure(state.failure);
  }
}
async function routeRead(state, route, request) {
  let aborted = false;
  const abort = async () => {
    aborted = true;
    await route.abort("blockedbyclient");
  };
  try {
    const current = request ?? route.request();
    const method = current.method();
    if (typeof method !== "string" || !/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(method)) {
      state.failure ??= "GALLERY_NOTICE_READ_GUARD_FAILED";
      await abort();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      const url = new URL(current.url());
      if (isNtulearnUrl(url.href)) {
        await abort();
        state.failure ??= "GALLERY_NOTICE_WRITE_BLOCKED";
        return;
      }
    }
    // Preserve lower-priority existing route handlers; never bypass them with continue().
    await route.fallback();
  } catch {
    state.failure = "GALLERY_NOTICE_READ_GUARD_FAILED";
    if (!aborted) {
      try {
        await abort();
      } catch {
        /* Unconfirmed guard remains failed. */
      }
    }
  }
}
async function bounded(operation, code = "GALLERY_NOTICE_UNRECOGNIZED") {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(galleryFailure(code)), GALLERY_WAIT_LIMITS.updateTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
