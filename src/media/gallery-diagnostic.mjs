export const GALLERY_WAIT_LIMITS = Object.freeze({ clickTimeoutMs: 5000, updateTimeoutMs: 5000 });

const FAILURES = Object.freeze({
  GALLERY_NOTICE_UNRECOGNIZED: [
    "opening",
    "Visible course dialog is unknown, multiple or malformed. Leave it untouched; Owner inspect the visible course page before retrying discovery.",
  ],
  GALLERY_NOTICE_READ_GUARD_FAILED: [
    "opening",
    "Owned Gallery read-only request guard could not be confirmed. No further navigation or dismissal authorized; close the owned context and inspect before retrying discovery.",
  ],
  GALLERY_NOTICE_SERVICE_WORKER: [
    "opening",
    "A known service worker prevents owned Gallery request-guard coverage. Leave the dialog untouched; close the owned context and inspect before retrying discovery.",
  ],
  GALLERY_NOTICE_WRITE_BLOCKED: [
    "opening",
    "The owned Gallery context attempted a non-read NTULearn request; it was blocked. Discovery remains incomplete; close the owned context and inspect before retrying.",
  ],
  GALLERY_NOTICE_CLOSE_FAILED: [
    "opening",
    "Dedicated announcement Close did not complete. Leave remaining dialogs untouched; Owner inspect before retrying discovery.",
  ],
  GALLERY_NOTICE_CLOSE_UNCONFIRMED: [
    "opening",
    "Announcement Close did not establish absence within its bounded wait. Discovery remains incomplete; Owner inspect before retrying.",
  ],
  GALLERY_TRIGGER_POINTER_INTERCEPTION: [
    "trigger",
    "The Media Gallery trigger click reported pointer interception. Inspect the visible course page, then retry media discovery.",
  ],
  GALLERY_TRIGGER_CLICK_FAILED: [
    "trigger",
    "The Media Gallery trigger click did not complete. Inspect the visible course page, then retry media discovery.",
  ],
  GALLERY_PAGINATION_CONTROL_UNAVAILABLE: [
    "pagination",
    "Media Gallery advertises another page but no enabled pagination control was found. Inspect the visible catalogue controls, then retry media discovery.",
  ],
  GALLERY_PAGINATION_CLICK_FAILED: [
    "pagination",
    "The Media Gallery pagination click did not complete. Inspect the visible catalogue controls, then retry media discovery.",
  ],
  GALLERY_PAGINATION_UPDATE_UNCONFIRMED: [
    "pagination",
    "The pagination control was clicked but catalogue advancement could not be confirmed within the bounded update wait. Inspect the visible catalogue, then retry media discovery.",
  ],
  GALLERY_PAGINATION_LIMIT_REACHED: [
    "pagination",
    "Media Gallery pagination reached its page safety limit before exhaustion. Inspect the displayed total and catalogue controls, then retry media discovery.",
  ],
  GALLERY_CATALOGUE_READ_FAILED: [
    "catalogue",
    "The Media Gallery catalogue could not be read. Inspect the visible catalogue, then retry media discovery.",
  ],
  GALLERY_SESSION_UNAVAILABLE: [
    "opening",
    "NTULearn session is not signed in; run npm run login, then retry Media Gallery discovery.",
  ],
  GALLERY_DISCOVERY_FAILED: [
    "opening",
    "Media Gallery discovery could not be confirmed. Inspect the visible course and catalogue, then retry media discovery.",
  ],
});

export function galleryFailure(code, evidence = {}) {
  if (!Object.hasOwn(FAILURES, code)) code = "GALLERY_DISCOVERY_FAILED";
  const [stage, message] = FAILURES[code];
  const error = new Error(message);
  error.code = code;
  error.diagnostic = {
    schemaVersion: 1,
    source: "student-visible-browser",
    code,
    stage:
      (code === "GALLERY_DISCOVERY_FAILED" || code.startsWith("GALLERY_NOTICE_")) &&
      ["opening", "catalogue", "date-enrichment"].includes(evidence.stage)
        ? evidence.stage
        : stage,
    pagesRead: count(evidence.pagesRead),
    pageLimit: count(evidence.pageLimit),
    displayedCount: count(evidence.snapshot?.displayedCount ?? evidence.displayedCount),
    observedCount: count(evidence.snapshot?.entries?.length ?? evidence.observedCount),
    hasMore:
      typeof evidence.snapshot?.hasMore === "boolean"
        ? evidence.snapshot.hasMore
        : typeof evidence.hasMore === "boolean"
          ? evidence.hasMore
          : null,
    control: ["trigger", "more", "numbered"].includes(evidence.control) ? evidence.control : null,
    ...GALLERY_WAIT_LIMITS,
  };
  return error;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
}
